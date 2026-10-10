import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadWebhookSecret } from "../../src/adapters/btcpay/config";
import { GreenfieldClient, type GreenfieldConfig } from "../../src/adapters/btcpay/greenfield-client";
import { PrismaInboxRepository } from "../../src/adapters/db/prisma-inbox-repository";
import { PrismaPaymentRepository } from "../../src/adapters/db/prisma-payment-repository";
import { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import { createInvoiceForOrder } from "../../src/application/create-invoice";
import { btcpayConfig, mineBlocks, pay } from "../helpers/regtest";
import { createTestDb } from "../helpers/test-db";
import { startWebhookServer, type WebhookServer } from "../helpers/webhook-server";

const SHOP = "test-shop.myshopify.com";
// bootstrap.sh が登録する Webhook の送信先
const WEBHOOK_URL = "http://host.docker.internal:3000/webhooks/btcpay";

// 本物の BTCPay から届く Webhook で、署名の検証 → inbox → ワーカー → Shopify への反映までを確かめる（design.md 5.3・4章、ADR 8）。
// シナリオ1（正常系）とシナリオ5（同じ Webhook を再送しても、Shopify の呼び出しは1回）
describe("BTCPay の Webhook とワーカー（regtest）", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;
  let config: GreenfieldConfig;
  let server: WebhookServer;
  let payments: PrismaPaymentRepository;
  let greenfield: GreenfieldClient;
  let shopify: FakeShopifyGateway;
  // シナリオ1で PAID にした Payment。シナリオ5で再送に使う
  let paid: { paymentId: string; invoiceId: string; shopifyOrderId: string } | undefined;

  beforeAll(async () => {
    ({ prisma, cleanup } = createTestDb());
    config = btcpayConfig();
    greenfield = new GreenfieldClient(config);
    payments = new PrismaPaymentRepository(prisma);
    shopify = new FakeShopifyGateway();
    const inbox = new PrismaInboxRepository(prisma);
    // secret はアプリと同じく .bootstrap.env（か環境変数）から読む
    server = await startWebhookServer(
      {
        payments,
        inbox,
        btcpay: greenfield,
        shopifyFor: async (shop) => {
          if (shop !== SHOP) throw new Error(`想定しないショップ ${shop}`);
          return shopify;
        },
      },
      loadWebhookSecret(process.env, bootstrapEnvPath()),
    );
  });

  afterAll(async () => {
    await server?.close();
    await cleanup();
  });

  it("シナリオ1: 入金 → 1ブロック生成で PAID になり、Shopify の注文が支払い済みになる", async () => {
    const shopifyOrderId = `gid://shopify/Order/${randomUUID()}`;
    shopify.addOrder({
      shopifyOrderId,
      paymentGatewayNames: ["Bitcoinで支払う"],
      financialStatus: "PENDING",
      cancelled: false,
      presentmentCurrencyCode: "JPY",
      outstanding: { amount: "1000.0", currencyCode: "JPY" },
    });
    const created = await createInvoiceForOrder({ shop: SHOP, payments, btcpay: greenfield, shopify }, shopifyOrderId);
    if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
    const { paymentId } = created.payment;
    const { invoiceId } = created.invoice;

    const { destination, due } = await paymentMethod(invoiceId);
    pay(destination, due);
    expect(await waitForStatus(paymentId, "CONFIRMING")).toBe("CONFIRMING");
    expect(shopify.markedAsPaid).toEqual([]);

    mineBlocks(1);
    expect(await waitForStatus(paymentId, "PAID")).toBe("PAID");
    await waitFor(async () => (await syncState(paymentId)) === "DONE");

    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
    expect((await shopify.getOrder(shopifyOrderId))?.financialStatus).toBe("PAID");
    expect(shopify.orderTags(shopifyOrderId)).toEqual([]);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { reviewFlags: true } });
    expect(row).toMatchObject({ shopifySync: "DONE", shopifySyncError: null, reviewFlags: [] });
    // 本物の secret で署名を検証できている（拒んだ配信がない）
    expect(server.rejected).toBe(0);
    paid = { paymentId, invoiceId, shopifyOrderId };
  });

  it("シナリオ5: PAID にした Webhook を BTCPay から再送しても、Shopify の呼び出しは1回", async () => {
    if (!paid) throw new Error("シナリオ1が通っていない");
    const { invoiceId, shopifyOrderId, paymentId } = paid;
    const settled = server.received.find(
      ({ event }) => event?.invoiceId === invoiceId && event.type === "InvoiceSettled",
    );
    if (!settled?.event) throw new Error("InvoiceSettled が届いていない");
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    // 手動の再送は新しい deliveryId で届くので、inbox の重複の除去では落ちない（ADR 8）。状態の判定で何も変わらないことを確かめる
    const count = server.received.length;
    await redeliver(settled.event.deliveryId);
    await waitFor(async () =>
      server.received
        .slice(count)
        .some(({ event }) => event?.invoiceId === invoiceId && event.type === "InvoiceSettled"),
    );

    const redelivered = server.received
      .slice(count)
      .find(({ event }) => event?.invoiceId === invoiceId && event.type === "InvoiceSettled");
    expect(redelivered?.event?.deliveryId).not.toBe(settled.event.deliveryId);
    expect(redelivered?.result).toEqual({ event: { outcome: "NO_CHANGE" }, sync: null });
    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toEqual(before);
  });

  function bootstrapEnvPath(): string {
    return new URL("../../../../infra/regtest/.bootstrap.env", import.meta.url).pathname;
  }

  async function greenfieldApi<T>(method: string, path: string): Promise<T> {
    const response = await fetch(`${config.baseUrl}/api/v1/stores/${config.storeId}${path}`, {
      method,
      headers: { Authorization: `token ${config.apiKey}` },
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  async function paymentMethod(invoiceId: string): Promise<{ destination: string; due: string }> {
    const [method] = await greenfieldApi<{ destination: string; due: string }[]>(
      "GET",
      `/invoices/${invoiceId}/payment-methods`,
    );
    return method;
  }

  // BTCPay の管理画面の「Redeliver」と同じ操作
  async function redeliver(deliveryId: string): Promise<void> {
    const webhooks = await greenfieldApi<{ id: string; url: string }[]>("GET", "/webhooks");
    const webhook = webhooks.find((w) => w.url === WEBHOOK_URL);
    if (!webhook) throw new Error(`${WEBHOOK_URL} の Webhook がない`);
    await greenfieldApi("POST", `/webhooks/${webhook.id}/deliveries/${deliveryId}/redeliver`);
  }

  async function syncState(paymentId: string): Promise<string> {
    return (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).shopifySync;
  }

  // Webhook は非同期に届くので、DB の状態が変わるまで待つ
  async function waitForStatus(paymentId: string, status: string): Promise<string> {
    await waitFor(async () => (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status === status);
    return (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status;
  }

  // 条件が成り立つまで待つ。30秒で諦め、呼び出し側の expect に判定を任せる
  async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!(await condition()) && Date.now() <= deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
});
