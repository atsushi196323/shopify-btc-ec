import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvoiceForOrder } from "../../src/application/create-invoice";
import { DEFAULT_SWEEP_SETTINGS, runSweep } from "../../src/application/sweep";
import { greenfieldApi, mineBlocks, pay, paymentMethod, waitFor } from "../helpers/regtest";
import { startRegtestApp, type RegtestApp } from "../helpers/regtest-app";
import { ShortExpiryBtcpayGateway } from "../helpers/short-expiry-btcpay";

// シナリオ6（design.md 7章、ADR 8）: Webhook を遮断しても、スイープで PAID に収束する。
// 期限後の入金の Webhook を遮断しても、スイープが EXPIRED の試行を照合して UNRESOLVED に収束することも確かめる。
// 本物の BTCPay と bitcoind（regtest）、フェイクの Shopify。テストプロセスの Webhook の受け口が、届いた配信を処理せずに捨てる
describe("シナリオ6: Webhook を遮断してもスイープで収束する（regtest）", () => {
  let app: RegtestApp;

  beforeAll(async () => {
    app = await startRegtestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("入金と1ブロックの Webhook がすべて届かなくても、スイープの照合で PAID になり、Shopify の注文が支払い済みになる", async () => {
    const { shopify, prisma, server } = app;
    server.blocked = true;
    const shopifyOrderId = app.addOrder();
    const created = await createInvoiceForOrder(app.invoiceDeps(), shopifyOrderId);
    if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
    const { paymentId } = created.payment;
    const { invoiceId } = created.invoice;

    const { destination, due } = await paymentMethod(app.config, invoiceId);
    pay(destination, due);
    mineBlocks(1);
    await waitFor(async () => (await invoiceStatus(invoiceId)) === "Settled");
    expect(await invoiceStatus(invoiceId)).toBe("Settled");

    // BTCPay では Settled だが、Webhook は1件も処理していないので、アプリは支払い待ちのまま
    expect(server.dropped).toBeGreaterThan(0);
    expect(server.received).toEqual([]);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({
      status: "AWAITING_PAYMENT",
    });

    const report = await runSweep(app.deps, DEFAULT_SWEEP_SETTINGS);

    expect(report.reconciled.find((item) => item.id === invoiceId)).toEqual({ id: invoiceId, outcome: "APPLIED" });
    expect(report.synced.find((item) => item.id === paymentId)).toEqual({ id: paymentId, outcome: "SYNCED" });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({
      status: "PAID",
      shopifySync: "DONE",
      shopifySyncError: null,
    });
    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);

    // もう一度回しても、何も変わらず、Shopify の呼び出しも増えない
    const again = await runSweep(app.deps, DEFAULT_SWEEP_SETTINGS);
    expect(again.reconciled.find((item) => item.id === invoiceId)).toBeUndefined();
    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
  });

  it(
    "期限後の入金の Webhook が届かなくても、スイープが EXPIRED の試行を照合して UNRESOLVED + LATE_PAYMENT にする",
    { timeout: 240_000 },
    async () => {
      const { shopify, prisma, server } = app;
      // 期限切れの Webhook は届けて EXPIRED にする。期限が1分の invoice を作る（ShortExpiryBtcpayGateway）
      server.blocked = false;
      const shopifyOrderId = app.addOrder();
      const created = await createInvoiceForOrder(
        app.invoiceDeps(new ShortExpiryBtcpayGateway(app.greenfield, app.config)),
        shopifyOrderId,
      );
      if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
      const { paymentId } = created.payment;
      const { invoiceId } = created.invoice;
      await waitFor(async () => (await paymentStatus(paymentId)) === "EXPIRED", 120_000);
      expect(await paymentStatus(paymentId)).toBe("EXPIRED");

      // 期限後の入金からは、Webhook を遮断する（自動再送は切ってあるので、BTCPay は送り直さない）
      server.blocked = true;
      const droppedBefore = server.dropped;
      const { destination, due } = await paymentMethod(app.config, invoiceId);
      pay(destination, due);
      await waitFor(async () => (await invoice(invoiceId)).additionalStatus === "PaidLate");
      await waitFor(async () => server.dropped > droppedBefore);
      expect(await invoice(invoiceId)).toMatchObject({ status: "Expired", additionalStatus: "PaidLate" });
      expect(await paymentStatus(paymentId)).toBe("EXPIRED");

      const report = await runSweep(app.deps, DEFAULT_SWEEP_SETTINGS);

      expect(report.reconciled.find((item) => item.id === invoiceId)).toEqual({ id: invoiceId, outcome: "APPLIED" });
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({
        status: "UNRESOLVED",
        shopifySync: "DONE",
        shopifySyncError: null,
      });
      const flags = await prisma.reviewFlag.findMany({ where: { paymentId } });
      expect(flags.map((flag) => flag.reason)).toEqual(["LATE_PAYMENT"]);
      expect(shopify.orderTags(shopifyOrderId)).toEqual(["btc-review-late-payment"]);
      expect(shopify.markedAsPaid).not.toContain(shopifyOrderId);
      mineBlocks(1);
    },
  );

  async function paymentStatus(paymentId: string): Promise<string> {
    return (await app.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status;
  }

  async function invoice(invoiceId: string): Promise<{ status: string; additionalStatus: string }> {
    return greenfieldApi(app.config, "GET", `/invoices/${invoiceId}`);
  }

  async function invoiceStatus(invoiceId: string): Promise<string> {
    return (await invoice(invoiceId)).status;
  }
});
