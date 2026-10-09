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

// 本物の BTCPay から届く Webhook で、署名の検証 → inbox → ワーカーが Payment を PAID まで進めることを確かめる（design.md 5.3、ADR 8）。
// Shopify への反映（orderMarkAsPaid）を含むシナリオ1は、反映処理を実装してから確かめる
describe("BTCPay の Webhook とワーカー（regtest）", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;
  let config: GreenfieldConfig;
  let server: WebhookServer;
  let payments: PrismaPaymentRepository;
  let greenfield: GreenfieldClient;

  beforeAll(async () => {
    ({ prisma, cleanup } = createTestDb());
    config = btcpayConfig();
    greenfield = new GreenfieldClient(config);
    payments = new PrismaPaymentRepository(prisma);
    const inbox = new PrismaInboxRepository(prisma);
    // secret はアプリと同じく .bootstrap.env（か環境変数）から読む
    server = await startWebhookServer({ payments, inbox, btcpay: greenfield }, loadWebhookSecret(process.env, bootstrapEnvPath()));
  });

  afterAll(async () => {
    await server?.close();
    await cleanup();
  });

  it("入金 → 1ブロック生成で、Webhook から PAID まで進む", async () => {
    const shopify = new FakeShopifyGateway();
    const shopifyOrderId = `gid://shopify/Order/${randomUUID()}`;
    shopify.addOrder({
      shopifyOrderId,
      paymentGatewayNames: ["Bitcoinで支払う"],
      financialStatus: "PENDING",
      cancelled: false,
      presentmentCurrencyCode: "JPY",
      outstanding: { amount: "1000.0", currencyCode: "JPY" },
    });
    const created = await createInvoiceForOrder({ payments, btcpay: greenfield, shopify }, shopifyOrderId);
    if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
    const { paymentId } = created.payment;

    const { destination, due } = await paymentMethod(created.invoice.invoiceId);
    pay(destination, due);
    expect(await waitForStatus(paymentId, "CONFIRMING")).toBe("CONFIRMING");

    mineBlocks(1);
    expect(await waitForStatus(paymentId, "PAID")).toBe("PAID");

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { reviewFlags: true } });
    expect(row).toMatchObject({ shopifySync: "PENDING", reviewFlags: [] });
    // 本物の secret で署名を検証できている（拒んだ配信がない）
    expect(server.rejected).toBe(0);
    expect(server.results.some((result) => result?.outcome === "APPLIED")).toBe(true);
  });

  function bootstrapEnvPath(): string {
    return new URL("../../../../infra/regtest/.bootstrap.env", import.meta.url).pathname;
  }

  async function paymentMethod(invoiceId: string): Promise<{ destination: string; due: string }> {
    const response = await fetch(`${config.baseUrl}/api/v1/stores/${config.storeId}/invoices/${invoiceId}/payment-methods`, {
      headers: { Authorization: `token ${config.apiKey}` },
    });
    const [method] = (await response.json()) as { destination: string; due: string }[];
    return method;
  }

  // Webhook は非同期に届くので、DB の状態が変わるまで待つ
  async function waitForStatus(paymentId: string, status: string): Promise<string> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (row.status === status || Date.now() > deadline) return row.status;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
});
