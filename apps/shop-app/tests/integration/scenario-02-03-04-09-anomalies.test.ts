import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvoiceForOrder, reissueInvoice, type InvoiceDeps } from "../../src/application/create-invoice";
import { mineBlocks, pay, paymentMethod, scaleBtc, waitFor } from "../helpers/regtest";
import { startRegtestApp, TEST_SHOP, type RegtestApp } from "../helpers/regtest-app";
import { ShortExpiryBtcpayGateway } from "../helpers/short-expiry-btcpay";

// 異常系と再発行（design.md 4章・5.4・6章、ADR 9）。本物の BTCPay と bitcoind（regtest）、フェイクの Shopify。
// 期限切れを待つシナリオは、期限が1分の invoice を作り（ShortExpiryBtcpayGateway）、並行に流して待ち時間を重ねる
const EXPIRY_WAIT_MS = 120_000;

describe.concurrent("異常系と再発行（regtest）", () => {
  let app: RegtestApp;
  let deps: InvoiceDeps;

  beforeAll(async () => {
    app = await startRegtestApp();
    deps = {
      shop: TEST_SHOP,
      payments: app.payments,
      btcpay: new ShortExpiryBtcpayGateway(app.greenfield, app.config),
      shopify: app.shopify,
    };
  });

  afterAll(async () => {
    await app?.close();
  });

  async function created(shopifyOrderId: string) {
    const result = await createInvoiceForOrder(deps, shopifyOrderId);
    if (result.outcome !== "CREATED") throw new Error(`CREATED ではない: ${result.outcome}`);
    return { paymentId: result.payment.paymentId, invoiceId: result.invoice.invoiceId };
  }

  // 入金なしで期限切れにしてから再発行する
  async function expiredAndReissued(shopifyOrderId: string) {
    const { paymentId, invoiceId: oldInvoiceId } = await created(shopifyOrderId);
    expect(await waitForStatus(paymentId, "EXPIRED", EXPIRY_WAIT_MS)).toBe("EXPIRED");
    const reissued = await reissueInvoice(deps, shopifyOrderId);
    if (reissued.outcome !== "REISSUED") throw new Error(`REISSUED ではない: ${reissued.outcome}`);
    return {
      paymentId,
      oldInvoiceId,
      newInvoiceId: reissued.invoice.invoiceId,
      newAttemptId: reissued.payment.currentAttempt.id,
    };
  }

  it("シナリオ2: 期限切れ → 再発行 → 新しい invoice に支払うと PAID", { timeout: 240_000 }, async () => {
    const shopifyOrderId = app.addOrder();
    const { paymentId, newInvoiceId } = await expiredAndReissued(shopifyOrderId);

    const { destination, due } = await paymentMethod(app.config, newInvoiceId);
    pay(destination, due);
    // 入金確認中（CONFIRMING）は確かめない。並行するほかのシナリオのブロック生成で、すぐに承認されることがある
    mineBlocks(1);
    expect(await waitForStatus(paymentId, "PAID")).toBe("PAID");
    await waitForSynced(paymentId);

    expect(app.shopify.markedAsPaid.filter((id) => id === shopifyOrderId)).toHaveLength(1);
    expect(await flags(paymentId)).toEqual([]);
  });

  it(
    "シナリオ2: 古い invoice への期限後の入金で、未入金の新しい invoice を無効化し、UNRESOLVED + LATE_PAYMENT。無効化後の入金は DOUBLE_PAYMENT",
    { timeout: 240_000 },
    async () => {
      const shopifyOrderId = app.addOrder();
      const { paymentId, oldInvoiceId, newInvoiceId, newAttemptId } = await expiredAndReissued(shopifyOrderId);
      const old = await paymentMethod(app.config, oldInvoiceId);
      const fresh = await paymentMethod(app.config, newInvoiceId);

      pay(old.destination, old.due);
      expect(await waitForStatus(paymentId, "UNRESOLVED")).toBe("UNRESOLVED");
      await waitFor(async () => (await invoiceStatus(newInvoiceId)) === "Invalid");
      expect(await invoiceStatus(newInvoiceId)).toBe("Invalid");
      expect(await app.prisma.invoiceAttempt.findUniqueOrThrow({ where: { id: newAttemptId } })).toMatchObject({
        invalidatedByUs: true,
      });
      expect(await flags(paymentId)).toEqual(["LATE_PAYMENT"]);
      await waitForSynced(paymentId);
      expect(app.shopify.orderTags(shopifyOrderId)).toEqual(["btc-review-late-payment"]);

      // 無効化した invoice への入金は invoice の状態に現れないので、payment-methods から検知する（ADR 9）
      pay(fresh.destination, fresh.due);
      await waitFor(async () => (await flags(paymentId)).includes("DOUBLE_PAYMENT"));
      expect(await flags(paymentId)).toEqual(["DOUBLE_PAYMENT", "LATE_PAYMENT"]);
      await waitForSynced(paymentId);
      expect(app.shopify.orderTags(shopifyOrderId)).toEqual(["btc-review-double-payment", "btc-review-late-payment"]);
      expect(app.shopify.markedAsPaid).not.toContain(shopifyOrderId);
      mineBlocks(1);
    },
  );

  it("シナリオ3: 一部入金のまま期限切れになると UNRESOLVED + UNDERPAID", { timeout: 240_000 }, async () => {
    const shopifyOrderId = app.addOrder();
    const { paymentId, invoiceId } = await created(shopifyOrderId);
    const { destination, due } = await paymentMethod(app.config, invoiceId);

    pay(destination, scaleBtc(due, 0.5));
    expect(await waitForStatus(paymentId, "UNRESOLVED", EXPIRY_WAIT_MS)).toBe("UNRESOLVED");

    expect(await flags(paymentId)).toEqual(["UNDERPAID"]);
    await waitForSynced(paymentId);
    expect(app.shopify.orderTags(shopifyOrderId)).toEqual(["btc-review-underpaid"]);
    expect(app.shopify.markedAsPaid).not.toContain(shopifyOrderId);
    mineBlocks(1);
  });

  it("シナリオ4: 過払いは PAID + OVERPAID", { timeout: 120_000 }, async () => {
    const shopifyOrderId = app.addOrder();
    const { paymentId, invoiceId } = await created(shopifyOrderId);
    const { destination, due } = await paymentMethod(app.config, invoiceId);

    pay(destination, scaleBtc(due, 1.5));
    // 入金確認中（CONFIRMING）は確かめない。並行するほかのシナリオのブロック生成で、すぐに承認されることがある
    mineBlocks(1);
    expect(await waitForStatus(paymentId, "PAID")).toBe("PAID");
    await waitForSynced(paymentId);

    expect(await flags(paymentId)).toEqual(["OVERPAID"]);
    expect(app.shopify.markedAsPaid.filter((id) => id === shopifyOrderId)).toHaveLength(1);
    expect(app.shopify.orderTags(shopifyOrderId)).toEqual(["btc-review-overpaid"]);
  });

  it("シナリオ9: 古い invoice と新しい invoice に同時に入金しても、DOUBLE_PAYMENT はちょうど1件", { timeout: 240_000 }, async () => {
    const shopifyOrderId = app.addOrder();
    const { paymentId, oldInvoiceId, newInvoiceId } = await expiredAndReissued(shopifyOrderId);
    const old = await paymentMethod(app.config, oldInvoiceId);
    const fresh = await paymentMethod(app.config, newInvoiceId);

    // 2つの入金の Webhook が続けて届き、ワーカーが並行に処理する。どちらが先でも DOUBLE_PAYMENT は必ず1件（不変条件2）
    pay(old.destination, old.due);
    pay(fresh.destination, fresh.due);
    await waitFor(async () => (await flags(paymentId)).includes("DOUBLE_PAYMENT"));
    mineBlocks(1);
    // 新しい invoice の処理が先なら PAID、古い invoice の処理が先なら（新しい invoice を無効化して）UNRESOLVED
    await waitFor(async () => ["PAID", "UNRESOLVED"].includes(await status(paymentId)));
    await waitForSynced(paymentId);

    const all = await flags(paymentId);
    expect(all.filter((reason) => reason === "DOUBLE_PAYMENT")).toHaveLength(1);
    expect(["PAID", "UNRESOLVED"]).toContain(await status(paymentId));
    expect(app.shopify.orderTags(shopifyOrderId)).toContain("btc-review-double-payment");
  });

  async function status(paymentId: string): Promise<string> {
    return (await app.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status;
  }

  async function waitForStatus(paymentId: string, expected: string, timeoutMs?: number): Promise<string> {
    await waitFor(async () => (await status(paymentId)) === expected, timeoutMs);
    return status(paymentId);
  }

  async function waitForSynced(paymentId: string): Promise<void> {
    await waitFor(
      async () => (await app.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).shopifySync === "DONE",
    );
    expect(await app.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({
      shopifySync: "DONE",
      shopifySyncError: null,
    });
  }

  async function flags(paymentId: string): Promise<string[]> {
    const rows = await app.prisma.reviewFlag.findMany({ where: { paymentId } });
    return rows.map((flag) => flag.reason).sort();
  }

  async function invoiceStatus(invoiceId: string): Promise<string> {
    const response = await fetch(`${app.config.baseUrl}/api/v1/stores/${app.config.storeId}/invoices/${invoiceId}`, {
      headers: { Authorization: `token ${app.config.apiKey}` },
    });
    return ((await response.json()) as { status: string }).status;
  }
});
