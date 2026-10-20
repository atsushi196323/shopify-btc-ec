import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeBtcpayEventDeps, composeInvoiceDeps } from "../../app/composition";
import { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import { createInvoiceForOrder } from "../../src/application/create-invoice";
import { handleBtcpayEvent } from "../../src/application/process-btcpay-event";
import { FakeBtcpayGateway } from "../helpers/fake-btcpay";
import { addBitcoinOrder } from "../helpers/orders";
import { createTestDb } from "../helpers/test-db";

// コンポジションルート（app/composition.ts。ADR 3・10）。本番（app/invoice.server.ts）と統合テストが同じ組み立てを使う。
// 本番の DB・BTCPay・Shopify を渡す部分（invoice.server.ts）は Shopify の認証に依存するので、手動の E2E で確かめる
describe("コンポジションルート", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    ({ prisma, cleanup } = createTestDb());
  });

  afterAll(async () => {
    await cleanup();
  });

  it("invoice の依存は、ショップの表記をそろえてから Payment に保存する", async () => {
    const shopify = new FakeShopifyGateway();
    const deps = composeInvoiceDeps(prisma, "HTTPS://Test-Shop.myshopify.com/", new FakeBtcpayGateway(), shopify);
    const shopifyOrderId = addBitcoinOrder(shopify);

    expect(deps.shop).toBe("test-shop.myshopify.com");
    await createInvoiceForOrder(deps, shopifyOrderId);

    expect(await prisma.payment.findUniqueOrThrow({ where: { shopifyOrderId } })).toMatchObject({
      shop: "test-shop.myshopify.com",
    });
  });

  it("ワーカーの依存は、同じ DB の inbox と Payment を使い、Payment のショップで Shopify を受け取る", async () => {
    const shopify = new FakeShopifyGateway();
    const btcpay = new FakeBtcpayGateway();
    const shopifyOrderId = addBitcoinOrder(shopify);
    const created = await createInvoiceForOrder(
      composeInvoiceDeps(prisma, "test-shop.myshopify.com", btcpay, shopify),
      shopifyOrderId,
    );
    if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
    btcpay.setObservation(created.invoice.invoiceId, { status: "SETTLED", received: "FULL" });
    const requestedShops: string[] = [];
    const deps = composeBtcpayEventDeps(prisma, btcpay, async (shop) => {
      requestedShops.push(shop);
      return shopify;
    });
    const { inboxId } = await deps.inbox.saveBtcpayEvent({
      eventId: "composition-test",
      type: "InvoiceSettled",
      invoiceId: created.invoice.invoiceId,
    });

    expect(await handleBtcpayEvent(deps, inboxId)).toMatchObject({ event: { outcome: "APPLIED" }, sync: { outcome: "SYNCED" } });

    expect(requestedShops).toEqual(["test-shop.myshopify.com"]);
    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
    expect(await prisma.inbox.findUniqueOrThrow({ where: { id: inboxId } })).toMatchObject({ status: "DONE" });
  });
});
