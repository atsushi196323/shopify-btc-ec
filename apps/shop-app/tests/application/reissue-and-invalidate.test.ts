import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaInboxRepository } from "../../src/adapters/db/prisma-inbox-repository";
import { PrismaPaymentRepository } from "../../src/adapters/db/prisma-payment-repository";
import { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import { createInvoiceForOrder, reissueInvoice, type InvoiceDeps } from "../../src/application/create-invoice";
import { reissueForExtension } from "../../src/application/extension-invoice";
import { invalidateAttempt } from "../../src/application/invalidate-attempt";
import { handleBtcpayEvent, type HandleEventDeps } from "../../src/application/process-btcpay-event";
import type { InvoiceObservation } from "../../src/domain/payment";
import { FakeBtcpayGateway } from "../helpers/fake-btcpay";
import { createTestDb } from "../helpers/test-db";

// 再発行（design.md 5.4）と、古い試行への期限後の入金での無効化（4章「古い試行に期限後の入金があったとき」、ADR 9）。
// DB は本物の SQLite、BTCPay と Shopify はフェイク。本物の BTCPay での確認はシナリオ2で行う
describe("再発行と無効化", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;
  let btcpay: FakeBtcpayGateway;
  let shopify: FakeShopifyGateway;
  let payments: PrismaPaymentRepository;
  let deps: InvoiceDeps & HandleEventDeps;

  beforeAll(() => {
    ({ prisma, cleanup } = createTestDb());
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(() => {
    btcpay = new FakeBtcpayGateway();
    shopify = new FakeShopifyGateway();
    payments = new PrismaPaymentRepository(prisma);
    deps = {
      shop: "test-shop.myshopify.com",
      payments,
      btcpay,
      shopify,
      inbox: new PrismaInboxRepository(prisma),
      shopifyFor: async () => shopify,
    };
  });

  function addOrder(amount = "1000.0"): string {
    const shopifyOrderId = `gid://shopify/Order/${randomUUID()}`;
    shopify.addOrder({
      shopifyOrderId,
      paymentGatewayNames: ["Bitcoinで支払う"],
      financialStatus: "PENDING",
      cancelled: false,
      presentmentCurrencyCode: "JPY",
      outstanding: { amount, currencyCode: "JPY" },
    });
    return shopifyOrderId;
  }

  async function observe(invoiceId: string, observation: InvoiceObservation) {
    btcpay.setObservation(invoiceId, observation);
    const { inboxId } = await deps.inbox.saveBtcpayEvent({ eventId: randomUUID(), type: "InvoiceUpdated", invoiceId });
    return handleBtcpayEvent(deps, inboxId);
  }

  // 入金なしで期限切れ（EXPIRED）にした注文
  async function expiredOrder() {
    const shopifyOrderId = addOrder();
    const created = await createInvoiceForOrder(deps, shopifyOrderId);
    if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
    await observe(created.invoice.invoiceId, { status: "EXPIRED", received: "NONE" });
    return { shopifyOrderId, paymentId: created.payment.paymentId, oldInvoiceId: created.invoice.invoiceId };
  }

  // 期限切れ → 再発行まで済ませた注文
  async function reissuedOrder() {
    const expired = await expiredOrder();
    const reissued = await reissueInvoice(deps, expired.shopifyOrderId);
    if (reissued.outcome !== "REISSUED") throw new Error(`REISSUED ではない: ${reissued.outcome}`);
    return {
      ...expired,
      newAttemptId: reissued.payment.currentAttempt.id,
      newInvoiceId: reissued.invoice.invoiceId,
    };
  }

  const paymentRow = (paymentId: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { attempts: true, reviewFlags: true } });

  describe("reissueInvoice", () => {
    it("EXPIRED なら新しい試行で invoice を作り、ポインタを付け替える。請求額は取り直す", async () => {
      const { shopifyOrderId, paymentId } = await expiredOrder();
      shopify.addOrder({ ...(await shopify.getOrder(shopifyOrderId))!, outstanding: { amount: "1200.0", currencyCode: "JPY" } });

      const result = await reissueInvoice(deps, shopifyOrderId);

      if (result.outcome !== "REISSUED") throw new Error(`REISSUED ではない: ${result.outcome}`);
      expect(result.payment).toMatchObject({ paymentId, status: "AWAITING_PAYMENT" });
      expect(btcpay.created.at(-1)).toMatchObject({
        attemptId: result.payment.currentAttempt.id,
        amount: "1200.0",
        invoiceId: result.invoice.invoiceId,
      });
      const row = await paymentRow(paymentId);
      expect(row.currentAttemptId).toBe(result.payment.currentAttempt.id);
      expect(row.attempts.map((a) => a.status).sort()).toEqual(["EXPIRED", "NEW"]);
    });

    it("EXPIRED でなければ何もしない", async () => {
      const shopifyOrderId = addOrder();
      await createInvoiceForOrder(deps, shopifyOrderId);

      expect(await reissueInvoice(deps, shopifyOrderId)).toMatchObject({
        outcome: "NOT_EXPIRED",
        payment: { status: "AWAITING_PAYMENT" },
      });
      expect(btcpay.created).toHaveLength(1);
      expect(await reissueInvoice(deps, addOrder())).toEqual({ outcome: "PAYMENT_NOT_FOUND" });
    });

    it("並列に押しても、新しい試行と invoice は1件", async () => {
      const { shopifyOrderId, paymentId } = await expiredOrder();

      const results = await Promise.all(Array.from({ length: 5 }, () => reissueInvoice(deps, shopifyOrderId)));

      expect(results.filter((r) => r.outcome === "REISSUED")).toHaveLength(1);
      // 負けた側は、読み直した今の Payment を返す（EXPIRED のままの古い状態を返さない）
      for (const r of results) {
        if (r.outcome === "NOT_EXPIRED") expect(r.payment.status).not.toBe("EXPIRED");
      }
      expect(btcpay.created).toHaveLength(2);
      expect((await paymentRow(paymentId)).attempts).toHaveLength(2);
    });

    it("invoice を作れない注文（キャンセル済みなど）では、試行を作らない", async () => {
      const { shopifyOrderId, paymentId } = await expiredOrder();
      shopify.addOrder({ ...(await shopify.getOrder(shopifyOrderId))!, cancelled: true });

      expect(await reissueInvoice(deps, shopifyOrderId)).toMatchObject({ outcome: "NOT_ELIGIBLE" });
      expect(await paymentRow(paymentId)).toMatchObject({ status: "EXPIRED", attempts: [expect.anything()] });
    });
  });

  describe("reissueForExtension", () => {
    it("別のショップの Payment は再発行せず、Admin API も呼ばない", async () => {
      const { shopifyOrderId, paymentId } = await expiredOrder();
      let getOrderCalls = 0;
      const counting = Object.create(shopify) as FakeShopifyGateway;
      counting.getOrder = (id) => {
        getOrderCalls++;
        return shopify.getOrder(id);
      };

      const view = await reissueForExtension({ ...deps, shop: "other-shop.myshopify.com", shopify: counting }, shopifyOrderId);

      expect(view).toEqual({ state: "PREPARING" });
      expect(getOrderCalls).toBe(0);
      expect(await paymentRow(paymentId)).toMatchObject({ status: "EXPIRED", attempts: [expect.anything()] });
    });

    it("再発行1回で、Admin API の注文の取得は1回", async () => {
      const { shopifyOrderId } = await expiredOrder();
      let getOrderCalls = 0;
      const counting = Object.create(shopify) as FakeShopifyGateway;
      counting.getOrder = (id) => {
        getOrderCalls++;
        return shopify.getOrder(id);
      };

      expect(await reissueForExtension({ ...deps, shopify: counting }, shopifyOrderId)).toMatchObject({
        state: "AWAITING_PAYMENT",
      });
      expect(getOrderCalls).toBe(1);
    });

    it("Payment はあるが Admin API で注文が見えなければ、再発行せずに PREPARING", async () => {
      const { shopifyOrderId, paymentId } = await expiredOrder();
      const hidden = Object.create(shopify) as FakeShopifyGateway;
      hidden.getOrder = async () => null;

      expect(await reissueForExtension({ ...deps, shopify: hidden }, shopifyOrderId)).toEqual({ state: "PREPARING" });
      expect(await paymentRow(paymentId)).toMatchObject({ status: "EXPIRED", attempts: [expect.anything()] });
    });

    it("新しい checkout link を返す。Payment のない注文は PREPARING", async () => {
      const { shopifyOrderId, oldInvoiceId } = await expiredOrder();

      const view = await reissueForExtension(deps, shopifyOrderId);

      expect(view).toEqual({ state: "AWAITING_PAYMENT", checkoutLink: expect.stringContaining("http://btcpay.test/i/") });
      expect(view).not.toEqual({ state: "AWAITING_PAYMENT", checkoutLink: `http://btcpay.test/i/${oldInvoiceId}` });
      expect(await reissueForExtension(deps, `gid://shopify/Order/${randomUUID()}`)).toEqual({ state: "PREPARING" });
    });
  });

  describe("古い試行への期限後の入金", () => {
    it("新しい試行が未入金なら、先に invalidatedByUs を記録してから新しい invoice を無効化し、UNRESOLVED + LATE_PAYMENT", async () => {
      const { paymentId, oldInvoiceId, newInvoiceId, newAttemptId } = await reissuedOrder();

      const handled = await observe(oldInvoiceId, { status: "EXPIRED", received: "LATE" });

      expect(handled.invalidation).toEqual({ outcome: "INVALIDATED" });
      expect(btcpay.invalidated).toEqual([newInvoiceId]);
      const row = await paymentRow(paymentId);
      expect(row).toMatchObject({ status: "UNRESOLVED" });
      expect(row.reviewFlags.map((f) => f.reason)).toEqual(["LATE_PAYMENT"]);
      expect(row.attempts.find((a) => a.id === newAttemptId)).toMatchObject({
        status: "NEW",
        invalidatedByUs: true,
        invalidatedAt: expect.any(Date),
      });
      // Shopify には LATE_PAYMENT のタグが付く
      expect(handled.sync).toEqual({ outcome: "SYNCED" });

      // 無効化の Webhook で新しい試行は INVALID になるが、フラグは増えない
      expect((await observe(newInvoiceId, { status: "INVALID", received: "NONE" })).event).toMatchObject({
        outcome: "APPLIED",
      });
      expect((await paymentRow(paymentId)).reviewFlags).toHaveLength(1);
    });

    it("無効化した invoice に後から入金があれば、DOUBLE_PAYMENT を付ける", async () => {
      const { paymentId, oldInvoiceId, newInvoiceId, newAttemptId } = await reissuedOrder();
      await observe(oldInvoiceId, { status: "EXPIRED", received: "LATE" });

      await observe(newInvoiceId, { status: "INVALID", received: "FULL" });

      const flags = (await paymentRow(paymentId)).reviewFlags.map((f) => [f.reason, f.attemptId]);
      expect(flags).toEqual(expect.arrayContaining([["DOUBLE_PAYMENT", newAttemptId]]));
    });

    it("BTCPay の無効化が失敗しても、invalidatedByUs は残り、もう一度呼ぶと無効化する", async () => {
      const { oldInvoiceId, newInvoiceId, newAttemptId } = await reissuedOrder();
      const failing = { ...deps, btcpay: Object.create(btcpay) as FakeBtcpayGateway };
      failing.btcpay.invalidateInvoice = () => Promise.reject(new Error("BTCPay が応答しない"));

      btcpay.setObservation(oldInvoiceId, { status: "EXPIRED", received: "LATE" });
      const { inboxId } = await deps.inbox.saveBtcpayEvent({ eventId: randomUUID(), type: "InvoiceUpdated", invoiceId: oldInvoiceId });
      expect((await handleBtcpayEvent(failing, inboxId)).invalidation).toEqual({
        outcome: "FAILED",
        error: "BTCPay が応答しない",
      });
      expect(await prisma.invoiceAttempt.findUniqueOrThrow({ where: { id: newAttemptId } })).toMatchObject({
        invalidatedByUs: true,
      });

      // スイープ（W4）が呼ぶのと同じ
      expect(await invalidateAttempt(deps, newAttemptId)).toEqual({ outcome: "INVALIDATED" });
      expect(btcpay.invalidated).toEqual([newInvoiceId]);
      // 無効化が済んで INVALID になった後は、もう呼ばない
      await observe(newInvoiceId, { status: "INVALID", received: "NONE" });
      expect(await invalidateAttempt(deps, newAttemptId)).toEqual({ outcome: "NOT_NEEDED" });
    });

    it("再発行の作成中に古い試行へ入金があり UNRESOLVED になったら、紐づけた新しい invoice を無効化する", async () => {
      const { shopifyOrderId, paymentId, oldInvoiceId } = await expiredOrder();
      // 新しい試行が CREATING の間（BTCPay の作成の前）に、古い invoice への期限後の入金を処理する
      btcpay.beforeCreate = async () => {
        btcpay.beforeCreate = () => {};
        const handled = await observe(oldInvoiceId, { status: "EXPIRED", received: "LATE" });
        expect(handled.invalidation).toBeNull();
      };

      const result = await reissueInvoice(deps, shopifyOrderId);

      if (result.outcome !== "REISSUED") throw new Error(`REISSUED ではない: ${result.outcome}`);
      expect(btcpay.invalidated).toEqual([result.invoice.invoiceId]);
      const row = await paymentRow(paymentId);
      expect(row.status).toBe("UNRESOLVED");
      expect(row.attempts.find((a) => a.id === result.payment.currentAttempt.id)).toMatchObject({ invalidatedByUs: true });
    });

    it("新しい試行が入金済み（CONFIRMING）なら無効化せず、DOUBLE_PAYMENT", async () => {
      const { paymentId, oldInvoiceId, newInvoiceId } = await reissuedOrder();
      await observe(newInvoiceId, { status: "PROCESSING", received: "FULL" });

      const handled = await observe(oldInvoiceId, { status: "EXPIRED", received: "LATE" });

      expect(handled.invalidation).toBeNull();
      expect(btcpay.invalidated).toEqual([]);
      const row = await paymentRow(paymentId);
      expect(row.status).toBe("CONFIRMING");
      expect(row.reviewFlags.map((f) => f.reason)).toEqual(["DOUBLE_PAYMENT"]);
    });
  });
});
