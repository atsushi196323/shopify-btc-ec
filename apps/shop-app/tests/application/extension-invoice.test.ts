import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPaymentRepository } from "../../src/adapters/db/prisma-payment-repository";
import { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import { recoverCreatingAttempt, type InvoiceDeps } from "../../src/application/create-invoice";
import { invoiceForExtension } from "../../src/application/extension-invoice";
import type { ShopifyOrder } from "../../src/application/ports/shopify-gateway";
import type { InvoiceObservation } from "../../src/domain/payment";
import { FakeBtcpayGateway } from "../helpers/fake-btcpay";
import { createTestDb } from "../helpers/test-db";

// 拡張 API（design.md 5.2）。DB は本物の SQLite、BTCPay と Shopify はフェイク
describe("拡張 API", () => {
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

  // 予約だけして invoice を紐づけていない Payment（CREATING）を作る
  async function reserve(shopifyOrderId: string): Promise<string> {
    const attemptId = randomUUID();
    await deps.payments.reserve({ paymentId: randomUUID(), attemptId, shop: "test-shop.myshopify.com", shopifyOrderId });
    return attemptId;
  }

  // invoice の様子を決めてから紐づけ、Payment をその状態に進める（W3 の Webhook 処理の代わりに、回復の経路を使う）
  async function paymentObserving(observation: InvoiceObservation): Promise<string> {
    const shopifyOrderId = addOrder();
    const attemptId = await reserve(shopifyOrderId);
    const invoice = await btcpay.createInvoice({ attemptId, shopifyOrderId, amount: "1000.0", currency: "JPY" });
    btcpay.setObservation(invoice.invoiceId, observation);
    await recoverCreatingAttempt(deps, attemptId);
    return shopifyOrderId;
  }

  it("Payment がなければ invoice を作り、checkout link を返す", async () => {
    const shopifyOrderId = addOrder();

    const view = await invoiceForExtension(deps, shopifyOrderId);

    expect(btcpay.created).toHaveLength(1);
    expect(view).toEqual({ state: "AWAITING_PAYMENT", checkoutLink: `http://btcpay.test/i/${btcpay.created[0].invoiceId}` });
  });

  it("2回目は invoice を作らず、同じ checkout link を返す", async () => {
    const shopifyOrderId = addOrder();
    const first = await invoiceForExtension(deps, shopifyOrderId);

    const second = await invoiceForExtension(deps, shopifyOrderId);

    expect(btcpay.created).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("Admin API で注文が見えなければ、Payment を見ずに PREPARING を返す", async () => {
    // 別のショップの注文も、このショップの Admin API では見えないのでここに来る
    const shopifyOrderId = `gid://shopify/Order/${randomUUID()}`;
    await reserve(shopifyOrderId);

    const view = await invoiceForExtension(deps, shopifyOrderId);

    expect(view).toEqual({ state: "PREPARING" });
    expect(btcpay.created).toHaveLength(0);
  });

  it("invoice を作れない注文には、何も作らずに NOT_APPLICABLE を返す", async () => {
    const shopifyOrderId = addOrder({ paymentGatewayNames: ["manual"] });

    const view = await invoiceForExtension(deps, shopifyOrderId);

    expect(view).toEqual({ state: "NOT_APPLICABLE" });
    expect(btcpay.created).toHaveLength(0);
    expect(await deps.payments.findByShopifyOrderId(shopifyOrderId)).toBeNull();
  });

  it("Payment が CREATING なら、自分では回復せずに PREPARING を返す", async () => {
    const shopifyOrderId = addOrder();
    await reserve(shopifyOrderId);

    const view = await invoiceForExtension(deps, shopifyOrderId);

    expect(view).toEqual({ state: "PREPARING" });
    expect(btcpay.created).toHaveLength(0);
  });

  it("Payment があれば、注文がもう支払い待ちでなくても状態を返す", async () => {
    const shopifyOrderId = await paymentObserving({ status: "SETTLED", received: "FULL" });
    const order = await shopify.getOrder(shopifyOrderId);
    if (!order) throw new Error("注文がない");
    shopify.addOrder({ ...order, financialStatus: "PAID" });

    expect(await invoiceForExtension(deps, shopifyOrderId)).toEqual({ state: "PAID" });
  });

  it.each([
    ["入金確認中", { status: "PROCESSING", received: "FULL" }, "CONFIRMING"],
    ["支払い済み", { status: "SETTLED", received: "FULL" }, "PAID"],
    ["期限切れ", { status: "EXPIRED", received: "NONE" }, "EXPIRED"],
    ["一部入金のまま期限切れ（UNRESOLVED）", { status: "EXPIRED", received: "PARTIAL" }, "CONTACT_SHOP"],
  ] as const)("%s なら checkout link を返さず、状態だけを返す", async (_, observation, state) => {
    const shopifyOrderId = await paymentObserving(observation);
    const createdBefore = btcpay.created.length;

    expect(await invoiceForExtension(deps, shopifyOrderId)).toEqual({ state });
    expect(btcpay.created).toHaveLength(createdBefore);
  });

  it("同じ注文に10並列で問い合わせても、invoice は1件で、全員に同じ checkout link を返す", async () => {
    const shopifyOrderId = addOrder();
    btcpay.beforeCreate = () => new Promise((resolve) => setTimeout(resolve, 50));

    const views = await Promise.all(Array.from({ length: 10 }, () => invoiceForExtension(deps, shopifyOrderId)));

    expect(btcpay.created).toHaveLength(1);
    // 予約に負けた呼び出しは、勝った側が紐づける前なら PREPARING になる
    const link = `http://btcpay.test/i/${btcpay.created[0].invoiceId}`;
    for (const view of views) {
      expect([{ state: "PREPARING" }, { state: "AWAITING_PAYMENT", checkoutLink: link }]).toContainEqual(view);
    }
    expect(views).toContainEqual({ state: "AWAITING_PAYMENT", checkoutLink: link });
  });
});
