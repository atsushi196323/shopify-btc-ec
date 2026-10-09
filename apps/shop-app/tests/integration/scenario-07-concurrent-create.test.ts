import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GreenfieldClient, type GreenfieldConfig } from "../../src/adapters/btcpay/greenfield-client";
import { PrismaPaymentRepository } from "../../src/adapters/db/prisma-payment-repository";
import { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import { createInvoiceForOrder, type InvoiceDeps } from "../../src/application/create-invoice";
import { invoiceForExtension } from "../../src/application/extension-invoice";
import { delay, InjectingBtcpayGateway } from "../helpers/btcpay-decorator";
import { btcpayConfig } from "../helpers/regtest";
import { createTestDb } from "../helpers/test-db";

// シナリオ7（design.md 7章、ADR 5）: invoice 作成の競合。
// orders/create Webhook と拡張 API の入口（ルートが呼ぶユースケース）をそれぞれ10並列で呼び、
// DB の Payment と本物の BTCPay の invoice がどちらも1件になることを確かめる。
// ルートは認証して application に渡すだけなので（ADR 3）、テストプロセスではユースケースに依存を組み立てて渡す（ADR 10）
describe("シナリオ7: invoice 作成の競合（regtest）", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;
  let config: GreenfieldConfig;

  beforeAll(() => {
    ({ prisma, cleanup } = createTestDb());
    config = btcpayConfig();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("Webhook と拡張から10並列ずつ作成しても、Payment と BTCPay の invoice はどちらも1件", async () => {
    const shopify = new FakeShopifyGateway();
    const btcpay = new InjectingBtcpayGateway(new GreenfieldClient(config));
    const deps: InvoiceDeps = { payments: new PrismaPaymentRepository(prisma), btcpay, shopify };
    const shopifyOrderId = `gid://shopify/Order/${randomUUID()}`;
    shopify.addOrder({
      shopifyOrderId,
      paymentGatewayNames: ["Bitcoinで支払う"],
      financialStatus: "PENDING",
      cancelled: false,
      presentmentCurrencyCode: "JPY",
      outstanding: { amount: "1000.0", currencyCode: "JPY" },
    });
    // 予約に勝った呼び出しが BTCPay から戻る前に、残りの全員が予約か既存の行の読み取りまで進むようにする
    btcpay.beforeCreate = delay(500);
    const startedAt = Math.floor(Date.now() / 1000);

    const [webhooks, views] = await Promise.all([
      Promise.all(Array.from({ length: 10 }, () => createInvoiceForOrder(deps, shopifyOrderId))),
      Promise.all(Array.from({ length: 10 }, () => invoiceForExtension(deps, shopifyOrderId))),
    ]);

    // DB: Payment も試行も1件
    const payments = await prisma.payment.findMany({ where: { shopifyOrderId }, include: { attempts: true } });
    expect(payments).toHaveLength(1);
    expect(payments[0].attempts).toHaveLength(1);
    const [attempt] = payments[0].attempts;
    expect(attempt).toMatchObject({ status: "NEW", btcpayInvoiceId: expect.any(String) });

    // BTCPay: 作成を頼んだのは1回で、この注文の invoice は1件だけ
    expect(btcpay.createCalls).toHaveLength(1);
    const invoices = await invoicesForOrder(shopifyOrderId, startedAt);
    expect(invoices.map((invoice) => invoice.id)).toEqual([attempt.btcpayInvoiceId]);
    expect(invoices[0].metadata.orderId).toBe(attempt.id);

    // 呼び出し側: Webhook で CREATED になるのは多くて1つ。拡張は作成中か、同じ checkout link の支払い待ち
    const created = webhooks.filter((result) => result.outcome === "CREATED");
    expect(created.length).toBeLessThanOrEqual(1);
    expect(webhooks.every((result) => result.outcome === "CREATED" || result.outcome === "EXISTING")).toBe(true);
    const checkoutLink = invoices[0].checkoutLink;
    for (const view of views) {
      expect([{ state: "PREPARING" }, { state: "AWAITING_PAYMENT", checkoutLink }]).toContainEqual(view);
    }

    // 作成が終わった後の問い合わせは、BTCPay を呼ばずに同じ invoice を返す
    expect(await invoiceForExtension(deps, shopifyOrderId)).toEqual({ state: "AWAITING_PAYMENT", checkoutLink });
    expect(btcpay.createCalls).toHaveLength(1);
  });

  type GreenfieldInvoice = { id: string; checkoutLink: string; metadata: { orderId?: string; shopifyOrderId?: string } };

  // BtcpayGateway には注文単位の検索がないので、テストから Greenfield を直接呼び、作成時刻以降の invoice を注文の ID で絞る
  async function invoicesForOrder(shopifyOrderId: string, since: number): Promise<GreenfieldInvoice[]> {
    // BTCPay のコンテナとホストの時計のずれを見込んで、少し前から取る
    const query = new URLSearchParams({ startDate: String(since - 60), take: "200" });
    const response = await fetch(`${config.baseUrl}/api/v1/stores/${config.storeId}/invoices?${query}`, {
      headers: { Authorization: `token ${config.apiKey}` },
    });
    if (!response.ok) throw new Error(`invoice の一覧: ${response.status}`);
    const invoices = (await response.json()) as GreenfieldInvoice[];
    return invoices.filter((invoice) => invoice.metadata.shopifyOrderId === shopifyOrderId);
  }
});
