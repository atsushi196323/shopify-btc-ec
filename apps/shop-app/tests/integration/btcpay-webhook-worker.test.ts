import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvoiceForOrder } from "../../src/application/create-invoice";
import { greenfieldApi, mineBlocks, pay, paymentMethod, waitFor } from "../helpers/regtest";
import { TEST_SHOP } from "../helpers/orders";
import { startRegtestApp, type RegtestApp } from "../helpers/regtest-app";

// bootstrap.sh が登録する Webhook の送信先
const WEBHOOK_URL = "http://host.docker.internal:3000/webhooks/btcpay";

// 本物の BTCPay から届く Webhook で、署名の検証 → inbox → ワーカー → Shopify への反映までを確かめる（design.md 5.3・4章、ADR 8）。
// シナリオ1（正常系）とシナリオ5（同じ Webhook を再送しても、Shopify の呼び出しは1回）
describe("BTCPay の Webhook とワーカー（regtest）", () => {
  let app: RegtestApp;
  // シナリオ1で PAID にした Payment。シナリオ5で再送に使う
  let paid: { paymentId: string; invoiceId: string; shopifyOrderId: string } | undefined;

  beforeAll(async () => {
    app = await startRegtestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("シナリオ1: 入金 → 1ブロック生成で PAID になり、Shopify の注文が支払い済みになる", async () => {
    const { shopify, prisma, server } = app;
    const shopifyOrderId = app.addOrder();
    const created = await createInvoiceForOrder(
      { shop: TEST_SHOP, payments: app.payments, btcpay: app.greenfield, shopify },
      shopifyOrderId,
    );
    if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
    const { paymentId } = created.payment;
    const { invoiceId } = created.invoice;

    const { destination, due } = await paymentMethod(app.config, invoiceId);
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
    const { shopify, prisma, server } = app;
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
    expect(redelivered?.result).toEqual({ event: { outcome: "NO_CHANGE" }, invalidation: null, sync: null });
    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toEqual(before);
  });

  // BTCPay の管理画面の「Redeliver」と同じ操作
  async function redeliver(deliveryId: string): Promise<void> {
    const webhooks = await greenfieldApi<{ id: string; url: string }[]>(app.config, "GET", "/webhooks");
    const webhook = webhooks.find((w) => w.url === WEBHOOK_URL);
    if (!webhook) throw new Error(`${WEBHOOK_URL} の Webhook がない`);
    await greenfieldApi(app.config, "POST", `/webhooks/${webhook.id}/deliveries/${deliveryId}/redeliver`);
  }

  async function syncState(paymentId: string): Promise<string> {
    return (await app.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).shopifySync;
  }

  async function waitForStatus(paymentId: string, status: string): Promise<string> {
    const read = async () => (await app.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status;
    await waitFor(async () => (await read()) === status);
    return read();
  }
});
