import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaInboxRepository } from "../../src/adapters/db/prisma-inbox-repository";
import { PrismaPaymentRepository } from "../../src/adapters/db/prisma-payment-repository";
import { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import { createInvoiceForOrder } from "../../src/application/create-invoice";
import { ForeignInvoiceError, type BtcpayGateway } from "../../src/application/ports/btcpay-gateway";
import type { InboxRepository } from "../../src/application/ports/inbox-repository";
import type { PaymentRepository } from "../../src/application/ports/payment-repository";
import { MAX_CONFLICT_RETRIES } from "../../src/application/retry-limits";
import {
  MAX_INBOX_ATTEMPTS,
  processBtcpayEvent,
  type ProcessEventDeps,
} from "../../src/application/process-btcpay-event";
import type { InvoiceObservation } from "../../src/domain/payment";
import { FakeBtcpayGateway } from "../helpers/fake-btcpay";
import { createTestDb } from "../helpers/test-db";
import { addBitcoinOrder, TEST_SHOP } from "../helpers/orders";

// BTCPay の Webhook のワーカー（design.md 5.3、ADR 8）。DB は本物の SQLite、BTCPay はフェイク。
// 本物の BTCPay から届く Webhook での確認は、統合テストのシナリオで行う
describe("processBtcpayEvent", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;
  let btcpay: FakeBtcpayGateway;
  let shopify: FakeShopifyGateway;
  let payments: PrismaPaymentRepository;
  let inbox: PrismaInboxRepository;
  let deps: ProcessEventDeps;

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
    inbox = new PrismaInboxRepository(prisma);
    deps = { payments, inbox, btcpay };
  });

  // 紐づけ済みの invoice（NEW・AWAITING_PAYMENT）を1つ作る
  async function awaitingPayment(): Promise<{ paymentId: string; attemptId: string; invoiceId: string }> {
    const shopifyOrderId = addBitcoinOrder(shopify);
    const created = await createInvoiceForOrder({ shop: TEST_SHOP, payments, btcpay, shopify }, shopifyOrderId);
    if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
    return {
      paymentId: created.payment.paymentId,
      attemptId: created.payment.currentAttempt.id,
      invoiceId: created.invoice.invoiceId,
    };
  }

  async function receive(invoiceId: string): Promise<string> {
    const { inboxId } = await inbox.saveBtcpayEvent({ eventId: randomUUID(), type: "InvoiceUpdated", invoiceId });
    return inboxId;
  }

  async function observe(invoiceId: string, observation: InvoiceObservation) {
    btcpay.setObservation(invoiceId, observation);
    return processBtcpayEvent(deps, await receive(invoiceId));
  }

  // getInvoice だけを差し替え、ほかはフェイクに任せる
  function withGetInvoice(getInvoice: BtcpayGateway["getInvoice"]): BtcpayGateway {
    return {
      getInvoice,
      createInvoice: (input) => btcpay.createInvoice(input),
      findInvoicesByAttemptId: (attemptId) => btcpay.findInvoicesByAttemptId(attemptId),
      invalidateInvoice: (invoiceId) => btcpay.invalidateInvoice(invoiceId),
    };
  }

  const paymentRow = (paymentId: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { reviewFlags: true } });
  const inboxRow = (inboxId: string) => prisma.inbox.findUniqueOrThrow({ where: { id: inboxId } });

  it("Greenfield の状態を取り直して、入金確認中 → 支払い済みに進め、inbox の行を DONE にする", async () => {
    const { paymentId, invoiceId } = await awaitingPayment();

    expect(await observe(invoiceId, { status: "PROCESSING", received: "FULL" })).toEqual({
      outcome: "APPLIED",
      paymentId,
      needsShopifySync: true,
      attemptToInvalidate: null,
    });
    expect(await paymentRow(paymentId)).toMatchObject({ status: "CONFIRMING", shopifySync: "PENDING" });

    const inboxId = await receive(invoiceId);
    btcpay.setObservation(invoiceId, { status: "SETTLED", received: "FULL" });
    expect(await processBtcpayEvent(deps, inboxId)).toMatchObject({ outcome: "APPLIED" });
    expect(await paymentRow(paymentId)).toMatchObject({ status: "PAID", reviewFlags: [] });
    expect(await inboxRow(inboxId)).toMatchObject({ status: "DONE", attempts: 0 });
  });

  it("ペイロードの種類は使わず、取り直した状態で判定する（取りこぼした途中の状態を飛ばす）", async () => {
    const { paymentId, invoiceId } = await awaitingPayment();

    // InvoiceUpdated しか届いていなくても、Greenfield が SETTLED なら PAID まで進む
    expect(await observe(invoiceId, { status: "SETTLED", received: "FULL" })).toMatchObject({ outcome: "APPLIED" });
    expect(await paymentRow(paymentId)).toMatchObject({ status: "PAID" });
  });

  it("処理済みの行は何もしない。同じ状態の別の配信は、何も変えずに DONE にする", async () => {
    const { paymentId, invoiceId } = await awaitingPayment();
    const first = await receive(invoiceId);
    btcpay.setObservation(invoiceId, { status: "PROCESSING", received: "FULL" });
    await processBtcpayEvent(deps, first);
    const before = await paymentRow(paymentId);

    expect(await processBtcpayEvent(deps, first)).toEqual({ outcome: "ALREADY_PROCESSED" });
    const resent = await receive(invoiceId);
    expect(await processBtcpayEvent(deps, resent)).toEqual({ outcome: "NO_CHANGE" });

    expect(await paymentRow(paymentId)).toEqual(before);
    expect(await inboxRow(resent)).toMatchObject({ status: "DONE" });
  });

  it("異常系はドメインの判定どおりにフラグを付ける（一部入金のまま期限切れ → UNRESOLVED + UNDERPAID）", async () => {
    const { paymentId, attemptId, invoiceId } = await awaitingPayment();

    await observe(invoiceId, { status: "EXPIRED", received: "PARTIAL" });

    expect(await paymentRow(paymentId)).toMatchObject({
      status: "UNRESOLVED",
      reviewFlags: [{ reason: "UNDERPAID", attemptId }],
    });
  });

  it("このアプリの試行に紐づかない invoice は、何もせずに DONE にする", async () => {
    // orderId 欄にほかの値が入った invoice（このアプリ以外の用途で作られたもの）
    const other = await btcpay.createInvoice({ attemptId: "not-an-attempt", shopifyOrderId: "x", amount: "1", currency: "JPY" });
    const inboxId = await receive(other.invoiceId);

    expect(await processBtcpayEvent(deps, inboxId)).toEqual({ outcome: "IGNORED" });
    expect(await inboxRow(inboxId)).toMatchObject({ status: "DONE" });
  });

  it("orderId 欄のない invoice（管理画面で手で作ったものなど）は、やり直さずに DONE にする", async () => {
    const inboxId = await receive("manual-invoice");
    const foreign = withGetInvoice((id) => Promise.reject(new ForeignInvoiceError(id)));

    expect(await processBtcpayEvent({ ...deps, btcpay: foreign }, inboxId)).toEqual({ outcome: "IGNORED" });
    expect(await inboxRow(inboxId)).toMatchObject({ status: "DONE", attempts: 0 });
  });

  it("試行に紐づかなかった方の invoice（ADR 5 の二重作成）のイベントは、何もせずに DONE にする", async () => {
    const { paymentId, attemptId } = await awaitingPayment();
    const loser = await btcpay.createInvoice({ attemptId, shopifyOrderId: "x", amount: "1000.0", currency: "JPY" });
    const before = await paymentRow(paymentId);

    expect(await observe(loser.invoiceId, { status: "PROCESSING", received: "FULL" })).toEqual({ outcome: "IGNORED" });
    expect(await paymentRow(paymentId)).toEqual(before);
  });

  it("試行に invoice がまだ紐づいていなければ、PENDING のまま残して後で処理する", async () => {
    const shopifyOrderId = randomUUID();
    const reservation = await payments.reserve({ paymentId: randomUUID(), attemptId: randomUUID(), shop: TEST_SHOP, shopifyOrderId });
    const attemptId = reservation.payment.currentAttempt.id;
    const invoice = await btcpay.createInvoice({ attemptId, shopifyOrderId, amount: "1000.0", currency: "JPY" });
    const inboxId = await receive(invoice.invoiceId);

    expect(await processBtcpayEvent(deps, inboxId)).toEqual({ outcome: "RETRY" });
    expect(await inboxRow(inboxId)).toMatchObject({ status: "PENDING", attempts: 1, lastError: expect.stringContaining("紐づいていない") });
    expect(await payments.findAttempt(attemptId)).toMatchObject({ status: "CREATING", btcpayInvoiceId: null });
  });

  it("Greenfield の呼び出しが失敗したら PENDING のまま残し、合計の上限で FAILED にする", async () => {
    const { invoiceId } = await awaitingPayment();
    const inboxId = await receive(invoiceId);
    const failing: ProcessEventDeps = {
      ...deps,
      btcpay: withGetInvoice(() => Promise.reject(new Error("BTCPay に届かない"))),
    };

    for (let i = 1; i < MAX_INBOX_ATTEMPTS; i++) {
      expect(await processBtcpayEvent(failing, inboxId)).toEqual({ outcome: "RETRY" });
    }
    expect(await processBtcpayEvent(failing, inboxId)).toEqual({ outcome: "FAILED" });

    expect(await inboxRow(inboxId)).toMatchObject({
      status: "FAILED",
      attempts: MAX_INBOX_ATTEMPTS,
      lastError: "BTCPay に届かない",
    });
    expect(await processBtcpayEvent(deps, inboxId)).toEqual({ outcome: "ALREADY_PROCESSED" });
  });

  it("失敗の記録そのものが失敗したら、記録をやり直さずに例外を返す（回数を二重に数えない）", async () => {
    const { invoiceId } = await awaitingPayment();
    const inboxId = await receive(invoiceId);
    let recorded = 0;
    const brokenInbox: InboxRepository = Object.assign(Object.create(inbox) as InboxRepository, {
      recordFailure: async () => {
        recorded++;
        throw new Error("SQLITE_BUSY");
      },
    });
    const failing = { ...deps, inbox: brokenInbox, btcpay: withGetInvoice(() => Promise.reject(new Error("BTCPay に届かない"))) };

    await expect(processBtcpayEvent(failing, inboxId)).rejects.toThrow("SQLITE_BUSY");
    expect(recorded).toBe(1);
  });

  it("失敗を記録しようとしたら別の処理が先に DONE にしていた場合は、処理済みとして返す", async () => {
    const { invoiceId } = await awaitingPayment();
    const inboxId = await receive(invoiceId);
    // Greenfield の呼び出しの間に、並行した別の処理がこの行を DONE にしたことにする
    const raced = withGetInvoice(async () => {
      await inbox.markDone(inboxId);
      throw new Error("BTCPay に届かない");
    });

    expect(await processBtcpayEvent({ ...deps, btcpay: raced }, inboxId)).toEqual({ outcome: "ALREADY_PROCESSED" });
    expect(await inboxRow(inboxId)).toMatchObject({ status: "DONE", attempts: 0 });
  });

  describe("version の競合", () => {
    // 保存の直前に、別の処理が Payment を更新したことにする（version だけを上げる）
    function interleaved(times: number): PaymentRepository {
      let remaining = times;
      return Object.assign(Object.create(payments) as PaymentRepository, {
        saveObservation: async (input: Parameters<PaymentRepository["saveObservation"]>[0]) => {
          if (remaining-- > 0) {
            await prisma.payment.update({ where: { id: input.paymentId }, data: { version: { increment: 1 } } });
          }
          return payments.saveObservation(input);
        },
      });
    }

    it("競合したら DB を読み直して再判定する。Greenfield は取り直さない", async () => {
      const { paymentId, invoiceId } = await awaitingPayment();
      btcpay.setObservation(invoiceId, { status: "PROCESSING", received: "FULL" });
      let fetched = 0;
      const counting = withGetInvoice((id) => (fetched++, btcpay.getInvoice(id)));
      const inboxId = await receive(invoiceId);

      const result = await processBtcpayEvent({ ...deps, btcpay: counting, payments: interleaved(1) }, inboxId);

      expect(result).toMatchObject({ outcome: "APPLIED" });
      expect(fetched).toBe(1);
      expect(await paymentRow(paymentId)).toMatchObject({ status: "CONFIRMING" });
      expect(await inboxRow(inboxId)).toMatchObject({ status: "DONE" });
    });

    it(`競合が ${MAX_CONFLICT_RETRIES} 回続いたら、PENDING のまま残す`, async () => {
      const { paymentId, invoiceId } = await awaitingPayment();
      btcpay.setObservation(invoiceId, { status: "PROCESSING", received: "FULL" });
      const inboxId = await receive(invoiceId);

      const result = await processBtcpayEvent({ ...deps, payments: interleaved(MAX_CONFLICT_RETRIES) }, inboxId);

      expect(result).toEqual({ outcome: "RETRY" });
      expect(await paymentRow(paymentId)).toMatchObject({ status: "AWAITING_PAYMENT" });
      expect(await inboxRow(inboxId)).toMatchObject({ status: "PENDING", attempts: 1 });
    });
  });

  describe("二重払いの直列化（ADR 6）", () => {
    // 期限切れの a1 と、再発行した a2（現在の試行、NEW）を持つ Payment を作る。再発行のユースケースは別の PR で実装する
    async function reissued() {
      const first = await awaitingPayment();
      btcpay.setObservation(first.invoiceId, { status: "EXPIRED", received: "NONE" });
      await processBtcpayEvent(deps, await receive(first.invoiceId));
      const a2 = randomUUID();
      const second = await btcpay.createInvoice({ attemptId: a2, shopifyOrderId: "x", amount: "1000.0", currency: "JPY" });
      await prisma.$transaction(async (tx) => {
        await tx.invoiceAttempt.create({
          data: { id: a2, paymentId: first.paymentId, status: "NEW", btcpayInvoiceId: second.invoiceId },
        });
        await tx.payment.update({
          where: { id: first.paymentId },
          data: { currentAttemptId: a2, status: "AWAITING_PAYMENT", version: { increment: 1 } },
        });
      });
      return { paymentId: first.paymentId, a1: first.attemptId, a1Invoice: first.invoiceId, a2, a2Invoice: second.invoiceId };
    }

    it("2つの試行への入金を並列に処理しても、DOUBLE_PAYMENT はちょうど1件付く", async () => {
      for (let round = 0; round < 10; round++) {
        const { paymentId, a1, a2, a1Invoice, a2Invoice } = await reissued();
        btcpay.setObservation(a1Invoice, { status: "EXPIRED", received: "LATE" });
        btcpay.setObservation(a2Invoice, { status: "PROCESSING", received: "FULL" });
        const [e1, e2] = [await receive(a1Invoice), await receive(a2Invoice)];

        const results = await Promise.all([processBtcpayEvent(deps, e1), processBtcpayEvent(deps, e2)]);

        expect(results.map((r) => r.outcome)).toEqual(["APPLIED", "APPLIED"]);
        const row = await paymentRow(paymentId);
        const doubles = row.reviewFlags.filter((flag) => flag.reason === "DOUBLE_PAYMENT");
        expect(doubles).toHaveLength(1);
        expect([a1, a2]).toContain(doubles[0].attemptId);
        expect(doubles[0].relatedAttemptId).toBe(doubles[0].attemptId === a1 ? a2 : a1);
      }
    });
  });
});
