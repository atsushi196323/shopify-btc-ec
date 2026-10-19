import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvoiceForOrder, reissueInvoice, type InvoiceDeps } from "../../src/application/create-invoice";
import { DEFAULT_SWEEP_SETTINGS, runSweep, type SweepSettings } from "../../src/application/sweep";
import { failOnce, InjectingBtcpayGateway } from "../helpers/btcpay-decorator";
import { mineBlocks, pay, paymentMethod, waitFor } from "../helpers/regtest";
import { TEST_SHOP } from "../helpers/orders";
import { startRegtestApp, type RegtestApp } from "../helpers/regtest-app";
import { ShortExpiryBtcpayGateway } from "../helpers/short-expiry-btcpay";

// シナリオ8（design.md 7章、ADR 5）: クラッシュからの回復。初回の作成と再発行の両方で、
// BTCPay で invoice を作った後・DB の更新の前に例外を注入し（テスト用デコレータ。ADR 10）、スイープの孤児回復が
// 作り直さずに同じ invoice を紐づけることを確かめる。本物の BTCPay と bitcoind（regtest）、フェイクの Shopify。
// スイープは DB 全体を見るので、作成中の呼び出しと重ならないように、テストは順に流す
const EXPIRY_WAIT_MS = 120_000;
// 孤児と inbox の行を待たずに拾う
const settings: SweepSettings = { ...DEFAULT_SWEEP_SETTINGS, orphanAfterMs: 0, inboxRetryAfterMs: 0 };

describe("シナリオ8: クラッシュからの回復（regtest）", () => {
  let app: RegtestApp;
  let btcpay: InjectingBtcpayGateway;
  let deps: InvoiceDeps;

  beforeAll(async () => {
    app = await startRegtestApp();
    btcpay = new InjectingBtcpayGateway(new ShortExpiryBtcpayGateway(app.greenfield, app.config));
    deps = { shop: TEST_SHOP, payments: app.payments, btcpay, shopify: app.shopify };
  });

  afterAll(async () => {
    await app?.close();
  });

  it("初回の作成: BTCPay で作った後に落ちても、スイープが同じ invoice を紐づけ、支払えば PAID になる", { timeout: 120_000 }, async () => {
    const shopifyOrderId = app.addOrder();
    btcpay.afterCreate = failOnce("作成の後に落ちた");

    await expect(createInvoiceForOrder(deps, shopifyOrderId)).rejects.toThrow("作成の後に落ちた");
    const stuck = await app.payments.findByShopifyOrderId(shopifyOrderId);
    expect(stuck).toMatchObject({ status: "CREATING", currentAttempt: { status: "CREATING", btcpayInvoiceId: null } });
    const attemptId = stuck!.currentAttempt.id;

    const report = await runSweep(app.deps, settings);

    expect(report.orphans.find((item) => item.id === attemptId)).toEqual({ id: attemptId, outcome: "RECOVERED" });
    await expectRecovered(shopifyOrderId, attemptId, 1);
  });

  it(
    "再発行: BTCPay で作った後に落ちても、スイープが新しい試行に同じ invoice を紐づけ、支払えば PAID になる",
    { timeout: 300_000 },
    async () => {
      const shopifyOrderId = app.addOrder();
      const created = await createInvoiceForOrder(deps, shopifyOrderId);
      if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
      const { paymentId } = created.payment;
      await waitFor(async () => (await status(paymentId)) === "EXPIRED", EXPIRY_WAIT_MS);
      expect(await status(paymentId)).toBe("EXPIRED");
      const callsBefore = btcpay.createCalls.length;
      btcpay.afterCreate = failOnce("再発行の作成の後に落ちた");

      await expect(reissueInvoice(deps, shopifyOrderId)).rejects.toThrow("再発行の作成の後に落ちた");
      const stuck = await app.payments.findByShopifyOrderId(shopifyOrderId);
      expect(stuck).toMatchObject({ status: "CREATING", currentAttempt: { status: "CREATING", btcpayInvoiceId: null } });
      const newAttemptId = stuck!.currentAttempt.id;
      expect(newAttemptId).not.toBe(created.payment.currentAttempt.id);

      const report = await runSweep(app.deps, settings);

      expect(report.orphans.find((item) => item.id === newAttemptId)).toEqual({ id: newAttemptId, outcome: "RECOVERED" });
      expect(btcpay.createCalls.length - callsBefore).toBe(1);
      await expectRecovered(shopifyOrderId, newAttemptId, 2);
    },
  );

  // 試行に紐づいた invoice が、BTCPay でこの試行の唯一の invoice であること（作り直していない）。支払えば PAID まで進む
  async function expectRecovered(shopifyOrderId: string, attemptId: string, attempts: number) {
    const payment = await app.prisma.payment.findUniqueOrThrow({
      where: { shopifyOrderId },
      include: { attempts: true, currentAttempt: true },
    });
    expect(payment).toMatchObject({ status: "AWAITING_PAYMENT", currentAttemptId: attemptId });
    expect(payment.attempts).toHaveLength(attempts);
    const invoices = await app.greenfield.findInvoicesByAttemptId(attemptId);
    expect(invoices.map((invoice) => invoice.invoiceId)).toEqual([payment.currentAttempt!.btcpayInvoiceId]);

    const { destination, due } = await paymentMethod(app.config, invoices[0].invoiceId);
    pay(destination, due);
    mineBlocks(1);
    await waitFor(async () => (await status(payment.id)) === "PAID");
    expect(await status(payment.id)).toBe("PAID");
    await waitFor(async () => app.shopify.markedAsPaid.includes(shopifyOrderId));
    expect(app.shopify.markedAsPaid.filter((id) => id === shopifyOrderId)).toHaveLength(1);
  }

  async function status(paymentId: string): Promise<string> {
    return (await app.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status;
  }
});
