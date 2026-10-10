import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPaymentRepository } from "../../src/adapters/db/prisma-payment-repository";
import type { ShopifyOrder } from "../../src/application/ports/shopify-gateway";
import { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import { createInvoiceForOrder, recoverCreatingAttempt, type InvoiceDeps } from "../../src/application/create-invoice";
import { FakeBtcpayGateway } from "../helpers/fake-btcpay";
import { createTestDb } from "../helpers/test-db";

// invoice の作成（design.md 5.1）と CREATING の試行の回復（5.5 の 1）。DB は本物の SQLite、BTCPay と Shopify はフェイク。
// 本物の BTCPay に対する競合（シナリオ7）とクラッシュ回復（シナリオ8）は統合テストで確かめる
describe("invoice の作成", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;
  let btcpay: FakeBtcpayGateway;
  let shopify: FakeShopifyGateway;
  let deps: InvoiceDeps;

  beforeAll(() => {
    ({ prisma, cleanup } = createTestDb());
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(() => {
    btcpay = new FakeBtcpayGateway();
    shopify = new FakeShopifyGateway();
    deps = { shop: "test-shop.myshopify.com", payments: new PrismaPaymentRepository(prisma), btcpay, shopify };
  });

  function addOrder(overrides: Partial<Omit<ShopifyOrder, "shopifyOrderId">> = {}): string {
    const shopifyOrderId = `gid://shopify/Order/${randomUUID()}`;
    shopify.addOrder({
      shopifyOrderId,
      paymentGatewayNames: ["Bitcoinで支払う"],
      financialStatus: "PENDING",
      cancelled: false,
      presentmentCurrencyCode: "JPY",
      outstanding: { amount: "1000.0", currencyCode: "JPY" },
      ...overrides,
    });
    return shopifyOrderId;
  }

  async function cancelOrder(shopifyOrderId: string): Promise<void> {
    const order = await shopify.getOrder(shopifyOrderId);
    if (!order) throw new Error("注文がない");
    shopify.addOrder({ ...order, cancelled: true });
  }

  describe("createInvoiceForOrder", () => {
    it("Shopify の残高で invoice を作り、orderId 欄には attemptId を入れる", async () => {
      const shopifyOrderId = addOrder({ outstanding: { amount: "2500.0", currencyCode: "JPY" } });

      const result = await createInvoiceForOrder(deps, shopifyOrderId);

      if (result.outcome !== "CREATED") throw new Error(`CREATED ではない: ${result.outcome}`);
      expect(result.payment).toMatchObject({ shopifyOrderId, status: "AWAITING_PAYMENT" });
      expect(result.payment.currentAttempt).toEqual({
        id: result.invoice.attemptId,
        status: "NEW",
        btcpayInvoiceId: result.invoice.invoiceId,
      });
      expect(btcpay.created).toEqual([
        {
          attemptId: result.payment.currentAttempt.id,
          shopifyOrderId,
          amount: "2500.0",
          currency: "JPY",
          invoiceId: result.invoice.invoiceId,
        },
      ]);
    });

    it("2回目は BTCPay を呼ばず、既存の Payment を返す", async () => {
      const shopifyOrderId = addOrder();
      const first = await createInvoiceForOrder(deps, shopifyOrderId);

      const second = await createInvoiceForOrder(deps, shopifyOrderId);

      expect(second).toEqual({ outcome: "EXISTING", payment: first.outcome === "CREATED" && first.payment });
      expect(btcpay.created).toHaveLength(1);
    });

    it("注文がなければ、何も作らない", async () => {
      const shopifyOrderId = `gid://shopify/Order/${randomUUID()}`;

      expect(await createInvoiceForOrder(deps, shopifyOrderId)).toEqual({ outcome: "ORDER_NOT_FOUND" });
      expect(await prisma.payment.findUnique({ where: { shopifyOrderId } })).toBeNull();
      expect(btcpay.created).toHaveLength(0);
    });

    it("invoice を作れない注文には、Payment も invoice も作らない", async () => {
      const shopifyOrderId = addOrder({ cancelled: true });

      expect(await createInvoiceForOrder(deps, shopifyOrderId)).toEqual({ outcome: "NOT_ELIGIBLE", reason: "CANCELLED" });
      expect(await prisma.payment.findUnique({ where: { shopifyOrderId } })).toBeNull();
      expect(btcpay.created).toHaveLength(0);
    });

    it("同じ注文に10並列で作成しても、Payment と invoice はどちらも1件", async () => {
      const shopifyOrderId = addOrder();
      // BTCPay の呼び出しを遅らせ、全員が予約までたどり着く状況を作る
      btcpay.beforeCreate = () => new Promise((resolve) => setTimeout(resolve, 50));

      const results = await Promise.all(Array.from({ length: 10 }, () => createInvoiceForOrder(deps, shopifyOrderId)));

      expect(results.filter((result) => result.outcome === "CREATED")).toHaveLength(1);
      expect(await prisma.payment.count({ where: { shopifyOrderId } })).toBe(1);
      expect(btcpay.created).toHaveLength(1);
    });

    it("BTCPay の呼び出しが失敗したら例外を返し、試行は CREATING のまま残る", async () => {
      const shopifyOrderId = addOrder();
      btcpay.beforeCreate = () => {
        throw new Error("BTCPay に届かない");
      };

      await expect(createInvoiceForOrder(deps, shopifyOrderId)).rejects.toThrow("BTCPay に届かない");

      const existing = await createInvoiceForOrder(deps, shopifyOrderId);
      expect(existing).toMatchObject({
        outcome: "EXISTING",
        payment: { status: "CREATING", currentAttempt: { status: "CREATING", btcpayInvoiceId: null } },
      });
    });
  });

  describe("recoverCreatingAttempt", () => {
    // BTCPay の呼び出しが失敗した状態（CREATING の孤児）を作る
    async function orphan(): Promise<{ shopifyOrderId: string; attemptId: string }> {
      const shopifyOrderId = addOrder();
      const original = btcpay.beforeCreate;
      btcpay.beforeCreate = () => {
        throw new Error("BTCPay に届かない");
      };
      await expect(createInvoiceForOrder(deps, shopifyOrderId)).rejects.toThrow();
      btcpay.beforeCreate = original;
      const payment = await deps.payments.findByShopifyOrderId(shopifyOrderId);
      if (!payment) throw new Error("Payment がない");
      return { shopifyOrderId, attemptId: payment.currentAttempt.id };
    }

    it("BTCPay に invoice がなければ作り直して紐づける", async () => {
      const { shopifyOrderId, attemptId } = await orphan();

      const result = await recoverCreatingAttempt(deps, attemptId);

      expect(result).toMatchObject({
        outcome: "RECREATED",
        payment: { shopifyOrderId, status: "AWAITING_PAYMENT", currentAttempt: { id: attemptId, status: "NEW" } },
      });
      expect(btcpay.created.map((invoice) => invoice.attemptId)).toEqual([attemptId]);
    });

    it("作り直す前に注文がキャンセルされていたら、作り直さずに CREATING のまま残す", async () => {
      const { shopifyOrderId, attemptId } = await orphan();
      await cancelOrder(shopifyOrderId);

      expect(await recoverCreatingAttempt(deps, attemptId)).toEqual({ outcome: "NOT_ELIGIBLE", reason: "CANCELLED" });
      expect(btcpay.created).toHaveLength(0);
      expect(await deps.payments.findAttempt(attemptId)).toMatchObject({ status: "CREATING", btcpayInvoiceId: null });
    });

    it("BTCPay で作った後に紐づけ前で落ちた invoice は、作り直さずに紐づける", async () => {
      const shopifyOrderId = addOrder();
      // 紐づけの前に落ちたことにする: BTCPay には invoice があるが、DB は CREATING のまま
      const reservation = await deps.payments.reserve({ paymentId: randomUUID(), attemptId: randomUUID(), shop: "test-shop.myshopify.com", shopifyOrderId });
      const attemptId = reservation.payment.currentAttempt.id;
      const invoice = await btcpay.createInvoice({ attemptId, shopifyOrderId, amount: "1000.0", currency: "JPY" });

      const result = await recoverCreatingAttempt(deps, attemptId);

      expect(result).toMatchObject({
        outcome: "RECOVERED",
        payment: { status: "AWAITING_PAYMENT", currentAttempt: { btcpayInvoiceId: invoice.invoiceId } },
      });
      expect(btcpay.created).toHaveLength(1);
    });

    it("見つかった invoice がすでに入金済みなら、その状態から始める", async () => {
      const { attemptId } = await orphan();
      const invoice = await btcpay.createInvoice({ attemptId, shopifyOrderId: "x", amount: "1000.0", currency: "JPY" });
      btcpay.setObservation(invoice.invoiceId, { status: "PROCESSING", received: "FULL" });

      const result = await recoverCreatingAttempt(deps, attemptId);

      expect(result).toMatchObject({
        outcome: "RECOVERED",
        payment: { status: "CONFIRMING", currentAttempt: { status: "PROCESSING" } },
      });
    });

    it("すでに紐づいた試行には何もしない", async () => {
      const shopifyOrderId = addOrder();
      const created = await createInvoiceForOrder(deps, shopifyOrderId);
      if (created.outcome !== "CREATED") throw new Error("CREATED ではない");

      expect(await recoverCreatingAttempt(deps, created.payment.currentAttempt.id)).toEqual({
        outcome: "ALREADY_ATTACHED",
      });
      expect(btcpay.created).toHaveLength(1);
    });

    it("作成中の呼び出しが後から紐づけに来ても、回復した側の invoice を正とする", async () => {
      const shopifyOrderId = addOrder();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      btcpay.beforeCreate = () => blocked;
      const slow = createInvoiceForOrder(deps, shopifyOrderId);
      // 遅い呼び出しが予約を終え、BTCPay の呼び出しで止まるのを待つ
      await expect.poll(() => deps.payments.findByShopifyOrderId(shopifyOrderId)).not.toBeNull();
      const payment = await deps.payments.findByShopifyOrderId(shopifyOrderId);
      btcpay.beforeCreate = () => {};

      const recovered = await recoverCreatingAttempt(deps, payment!.currentAttempt.id);
      release();
      const late = await slow;

      expect(recovered.outcome).toBe("RECREATED");
      expect(late).toEqual({ outcome: "EXISTING", payment: recovered.outcome === "RECREATED" && recovered.payment });
      // 遅い呼び出しが作った invoice は BTCPay に残るが、試行には紐づかない（ADR 5）
      expect(btcpay.created).toHaveLength(2);
    });
  });
});
