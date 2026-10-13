import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaInboxRepository } from "../../src/adapters/db/prisma-inbox-repository";
import { PrismaPaymentRepository } from "../../src/adapters/db/prisma-payment-repository";
import { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import { createInvoiceForOrder, reissueInvoice } from "../../src/application/create-invoice";
import { handleBtcpayEvent } from "../../src/application/process-btcpay-event";
import { runSweep, type SweepDeps, type SweepItem, type SweepSettings } from "../../src/application/sweep";
import type { InvoiceObservation } from "../../src/domain/payment";
import { FakeBtcpayGateway } from "../helpers/fake-btcpay";
import { createTestDb } from "../helpers/test-db";
import { addBitcoinOrder, TEST_SHOP } from "../helpers/orders";

// スイープ（design.md 5.5）。DB は本物の SQLite、BTCPay と Shopify はフェイク。
// DB はファイルの中で共有するので、結果は自分のテストで作った id で絞って確かめる。本物の BTCPay での確認はシナリオ6・8で行う
describe("runSweep", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;
  let btcpay: FakeBtcpayGateway;
  let shopify: FakeShopifyGateway;
  let payments: PrismaPaymentRepository;
  let deps: SweepDeps;

  // 孤児と inbox の行は待たずに拾う。監視期間は既定と同じ
  const settings: SweepSettings = { orphanAfterMs: 0, invalidatedWatchMs: 600_000, inboxRetryAfterMs: 0 };

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
    deps = { payments, inbox: new PrismaInboxRepository(prisma), btcpay, shopifyFor: async () => shopify };
  });

  const invoiceDeps = () => ({ shop: TEST_SHOP, payments, btcpay, shopify });

  async function awaitingPayment() {
    const shopifyOrderId = addBitcoinOrder(shopify);
    const created = await createInvoiceForOrder(invoiceDeps(), shopifyOrderId);
    if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
    return { shopifyOrderId, paymentId: created.payment.paymentId, invoiceId: created.invoice.invoiceId };
  }

  // 予約だけを済ませ、BTCPay を呼ぶ前に落ちた（試行が CREATING のまま残った）注文
  async function reservedOnly(overrides: Parameters<typeof addBitcoinOrder>[1] = {}) {
    const shopifyOrderId = addBitcoinOrder(shopify, overrides);
    const { payment } = await payments.reserve({
      paymentId: randomUUID(),
      attemptId: randomUUID(),
      shop: TEST_SHOP,
      shopifyOrderId,
    });
    return { shopifyOrderId, paymentId: payment.paymentId, attemptId: payment.currentAttempt.id };
  }

  // Webhook が届いたときと同じく、ワーカーの1件分を流す
  async function observe(invoiceId: string, observation: InvoiceObservation) {
    btcpay.setObservation(invoiceId, observation);
    const { inboxId } = await deps.inbox.saveBtcpayEvent({ eventId: randomUUID(), type: "InvoiceUpdated", invoiceId });
    return handleBtcpayEvent(deps, inboxId);
  }

  const paymentRow = (paymentId: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { attempts: true, reviewFlags: true } });

  const itemOf = (items: SweepItem[], id: string) => items.find((item) => item.id === id);

  describe("1. 孤児の回復", () => {
    it("BTCPay に invoice があれば、作り直さずに紐づける", async () => {
      const { paymentId, attemptId, shopifyOrderId } = await reservedOnly();
      // BTCPay で作った後、紐づける前に落ちた
      const invoice = await btcpay.createInvoice({ attemptId, shopifyOrderId, amount: "1000.0", currency: "JPY" });

      const report = await runSweep(deps, settings);

      expect(itemOf(report.orphans, attemptId)).toEqual({ id: attemptId, outcome: "RECOVERED" });
      expect(btcpay.created).toHaveLength(1);
      const row = await paymentRow(paymentId);
      expect(row).toMatchObject({ status: "AWAITING_PAYMENT" });
      expect(row.attempts).toMatchObject([{ id: attemptId, status: "NEW", btcpayInvoiceId: invoice.invoiceId }]);
    });

    it("BTCPay に invoice がなければ、注文を確かめ直して作り直す", async () => {
      const { paymentId, attemptId } = await reservedOnly();

      const report = await runSweep(deps, settings);

      expect(itemOf(report.orphans, attemptId)).toEqual({ id: attemptId, outcome: "RECREATED" });
      expect(btcpay.created.map((c) => c.attemptId)).toEqual([attemptId]);
      expect(await paymentRow(paymentId)).toMatchObject({ status: "AWAITING_PAYMENT" });
    });

    it("作り直せない注文（キャンセル済み）の試行は、CREATING のまま残す", async () => {
      const { paymentId, attemptId } = await reservedOnly({ cancelled: true });

      const report = await runSweep(deps, settings);

      expect(itemOf(report.orphans, attemptId)).toEqual({ id: attemptId, outcome: "NOT_ELIGIBLE" });
      expect(btcpay.created).toEqual([]);
      expect(await paymentRow(paymentId)).toMatchObject({ status: "CREATING" });
    });

    it("作られてから orphanAfterMs が経っていない試行には触れない（作成中の呼び出しと重ならないようにする）", async () => {
      const { attemptId } = await reservedOnly();

      const report = await runSweep(deps, { ...settings, orphanAfterMs: 60_000 });

      expect(itemOf(report.orphans, attemptId)).toBeUndefined();
      expect(btcpay.created).toEqual([]);
    });
  });

  describe("2. 照合", () => {
    it("Webhook が届かなくても、Greenfield から取り直して PAID にし、同じ回で Shopify に反映する", async () => {
      const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();
      btcpay.setObservation(invoiceId, { status: "SETTLED", received: "FULL" });

      const report = await runSweep(deps, settings);

      expect(itemOf(report.reconciled, invoiceId)).toEqual({ id: invoiceId, outcome: "APPLIED" });
      expect(itemOf(report.synced, paymentId)).toEqual({ id: paymentId, outcome: "SYNCED" });
      expect(await paymentRow(paymentId)).toMatchObject({ status: "PAID", shopifySync: "DONE" });
      expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);

      // PAID の試行は終端なので、次の回では照合しない。Shopify の呼び出しも増えない
      const next = await runSweep(deps, settings);
      expect(itemOf(next.reconciled, invoiceId)).toBeUndefined();
      expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
    });

    it("変わっていなければ何もしない", async () => {
      const { paymentId, invoiceId } = await awaitingPayment();
      const before = await paymentRow(paymentId);

      const report = await runSweep(deps, settings);

      expect(itemOf(report.reconciled, invoiceId)).toEqual({ id: invoiceId, outcome: "NO_CHANGE" });
      expect((await paymentRow(paymentId)).version).toBe(before.version);
    });

    it("1件が失敗しても、残りの照合は続ける", async () => {
      const broken = await awaitingPayment();
      const ok = await awaitingPayment();
      btcpay.setObservation(ok.invoiceId, { status: "PROCESSING", received: "FULL" });
      const getInvoice = btcpay.getInvoice.bind(btcpay);
      btcpay.getInvoice = async (id) => {
        if (id === broken.invoiceId) throw new Error("BTCPay が応答しない");
        return getInvoice(id);
      };

      const report = await runSweep(deps, settings);

      expect(itemOf(report.reconciled, broken.invoiceId)).toEqual({
        id: broken.invoiceId,
        outcome: "ERROR",
        error: "BTCPay が応答しない",
      });
      expect(itemOf(report.reconciled, ok.invoiceId)).toEqual({ id: ok.invoiceId, outcome: "APPLIED" });
      expect(await paymentRow(ok.paymentId)).toMatchObject({ status: "CONFIRMING" });
    });
  });

  // 期限切れ → 再発行 → 古い invoice に期限後の入金。新しい invoice の無効化は失敗させておく
  async function lateWithFailedInvalidation() {
    const { shopifyOrderId, paymentId, invoiceId: oldInvoiceId } = await awaitingPayment();
    await observe(oldInvoiceId, { status: "EXPIRED", received: "NONE" });
    const reissued = await reissueInvoice(invoiceDeps(), shopifyOrderId);
    if (reissued.outcome !== "REISSUED") throw new Error(`REISSUED ではない: ${reissued.outcome}`);
    const invalidate = btcpay.invalidateInvoice.bind(btcpay);
    btcpay.invalidateInvoice = async () => {
      throw new Error("BTCPay が応答しない");
    };
    const handled = await observe(oldInvoiceId, { status: "EXPIRED", received: "LATE" });
    expect(handled.invalidation).toMatchObject({ outcome: "FAILED" });
    btcpay.invalidateInvoice = invalidate;
    return {
      paymentId,
      newAttemptId: reissued.payment.currentAttempt.id,
      newInvoiceId: reissued.invoice.invoiceId,
    };
  }

  describe("3. 無効化のリトライ・4. 無効化した試行の監視", () => {
    it("UNRESOLVED なのに現在の試行が NEW なら無効化し、同じ回の監視（4）で試行を INVALID にする", async () => {
      const { paymentId, newAttemptId, newInvoiceId } = await lateWithFailedInvalidation();
      expect(await paymentRow(paymentId)).toMatchObject({ status: "UNRESOLVED" });

      const first = await runSweep(deps, settings);
      expect(itemOf(first.invalidated, newAttemptId)).toEqual({ id: newAttemptId, outcome: "INVALIDATED" });
      expect(itemOf(first.watched, newInvoiceId)).toEqual({ id: newInvoiceId, outcome: "APPLIED" });
      expect(btcpay.invalidated).toEqual([newInvoiceId]);
      const row = await paymentRow(paymentId);
      expect(row.attempts.find((a) => a.id === newAttemptId)).toMatchObject({ status: "INVALID", invalidatedByUs: true });

      // 次の回では、無効化も照合（2）もしない
      const second = await runSweep(deps, settings);
      expect(itemOf(second.invalidated, newAttemptId)).toBeUndefined();
      expect(itemOf(second.reconciled, newInvoiceId)).toBeUndefined();
      expect(btcpay.invalidated).toEqual([newInvoiceId]);
    });

    it("監視期間の間に、無効化した invoice への入金を見つけたら DOUBLE_PAYMENT を付ける", async () => {
      const { paymentId, newInvoiceId } = await lateWithFailedInvalidation();
      await runSweep(deps, settings);
      // 無効化の直後に入金が届いたが、その Webhook を取りこぼした
      btcpay.setObservation(newInvoiceId, { status: "INVALID", received: "FULL" });

      const report = await runSweep(deps, settings);

      expect(itemOf(report.watched, newInvoiceId)).toEqual({ id: newInvoiceId, outcome: "APPLIED" });
      const row = await paymentRow(paymentId);
      expect(row.reviewFlags.map((f) => f.reason).sort()).toEqual(["DOUBLE_PAYMENT", "LATE_PAYMENT"]);
      expect(row.shopifySync).toBe("DONE");
    });

    it("監視期間を過ぎた試行は照合しない", async () => {
      const { newInvoiceId } = await lateWithFailedInvalidation();
      await runSweep(deps, settings);
      btcpay.setObservation(newInvoiceId, { status: "INVALID", received: "FULL" });

      const later = new Date(Date.now() + settings.invalidatedWatchMs + 1_000);
      const report = await runSweep({ ...deps, now: () => later }, settings);

      expect(itemOf(report.watched, newInvoiceId)).toBeUndefined();
    });
  });

  describe("5. inbox の再処理・6. Shopify への反映", () => {
    it("PENDING のまま残った inbox の行を処理する", async () => {
      const { paymentId, invoiceId } = await awaitingPayment();
      btcpay.setObservation(invoiceId, { status: "PROCESSING", received: "FULL" });
      // 保存した後、ワーカーが処理する前に落ちた
      const { inboxId } = await deps.inbox.saveBtcpayEvent({ eventId: randomUUID(), type: "InvoiceUpdated", invoiceId });

      const report = await runSweep(deps, settings);

      // 照合（2）が先に CONFIRMING にするので、inbox の行は変わるものがなく DONE になる
      expect(itemOf(report.inbox, inboxId)).toEqual({ id: inboxId, outcome: "NO_CHANGE" });
      expect(await prisma.inbox.findUniqueOrThrow({ where: { id: inboxId } })).toMatchObject({ status: "DONE" });
      expect(await paymentRow(paymentId)).toMatchObject({ status: "CONFIRMING" });
    });

    it("受信か最後の失敗から inboxRetryAfterMs が経っていない行には触れない（ワーカーが処理中の行と重ならないようにする）", async () => {
      const { invoiceId } = await awaitingPayment();
      const { inboxId } = await deps.inbox.saveBtcpayEvent({ eventId: randomUUID(), type: "InvoiceUpdated", invoiceId });

      const report = await runSweep(deps, { ...settings, inboxRetryAfterMs: 60_000 });

      expect(itemOf(report.inbox, inboxId)).toBeUndefined();
      expect(await prisma.inbox.findUniqueOrThrow({ where: { id: inboxId } })).toMatchObject({ status: "PENDING", attempts: 0 });
    });

    it("反映に失敗して PENDING のまま残った Payment を、次の回で反映する", async () => {
      const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();
      const markOrderAsPaid = shopify.markOrderAsPaid.bind(shopify);
      shopify.markOrderAsPaid = async () => {
        throw new Error("Shopify が応答しない");
      };
      const handled = await observe(invoiceId, { status: "SETTLED", received: "FULL" });
      expect(handled.sync).toMatchObject({ outcome: "FAILED" });
      shopify.markOrderAsPaid = markOrderAsPaid;

      const report = await runSweep(deps, settings);

      expect(itemOf(report.synced, paymentId)).toEqual({ id: paymentId, outcome: "SYNCED" });
      expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
      expect(await paymentRow(paymentId)).toMatchObject({ shopifySync: "DONE", shopifySyncError: null });
    });
  });
});
