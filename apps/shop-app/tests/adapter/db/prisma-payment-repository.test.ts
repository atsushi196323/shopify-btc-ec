import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPaymentRepository } from "../../../src/adapters/db/prisma-payment-repository";
import { applyObservation, reissue, type InvoiceObservation } from "../../../src/domain/payment";
import { createTestDb } from "../../helpers/test-db";

// 予約（design.md 3章「作成の順序と不変条件」、ADR 5・7）と、invoice の紐づけ
describe("PrismaPaymentRepository", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;
  let repository: PrismaPaymentRepository;

  beforeAll(() => {
    ({ prisma, cleanup } = createTestDb());
    repository = new PrismaPaymentRepository(prisma);
  });

  afterAll(async () => {
    await cleanup();
  });

  const reserve = (shopifyOrderId = randomUUID()) =>
    repository.reserve({ paymentId: randomUUID(), attemptId: randomUUID(), shop: "test-shop.myshopify.com", shopifyOrderId });

  const attach = (attemptId: string, observation: InvoiceObservation = { status: "NEW", received: "NONE" }) =>
    repository.attachInvoice({
      attemptId,
      btcpayInvoiceId: randomUUID(),
      decide: (state) => applyObservation(state, attemptId, observation),
    });

  describe("reserve", () => {
    it("Payment・CREATING の試行・ポインタを作る", async () => {
      const shopifyOrderId = randomUUID();
      const paymentId = randomUUID();
      const attemptId = randomUUID();

      const result = await repository.reserve({ paymentId, attemptId, shop: "test-shop.myshopify.com", shopifyOrderId });

      expect(result).toEqual({
        reserved: true,
        payment: {
          paymentId,
          shop: "test-shop.myshopify.com",
          shopifyOrderId,
          status: "CREATING",
          version: 0,
          currentAttempt: { id: attemptId, status: "CREATING", btcpayInvoiceId: null },
        },
      });
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(row).toMatchObject({ shop: "test-shop.myshopify.com", currentAttemptId: attemptId, shopifySync: "DONE" });
    });

    it("同じ shopifyOrderId では負け、既存の Payment を返す。負けた側の行は残らない", async () => {
      const first = await reserve();
      const loserAttemptId = randomUUID();

      const second = await repository.reserve({
        paymentId: randomUUID(),
        attemptId: loserAttemptId,
        shop: "test-shop.myshopify.com",
        shopifyOrderId: first.payment.shopifyOrderId,
      });

      expect(second).toEqual({ reserved: false, payment: first.payment });
      expect(await prisma.invoiceAttempt.findUnique({ where: { id: loserAttemptId } })).toBeNull();
    });

    it("同じ注文を10並列で予約しても、勝つのは1つで、全員が同じ Payment を返す", async () => {
      const shopifyOrderId = randomUUID();

      const results = await Promise.all(Array.from({ length: 10 }, () => reserve(shopifyOrderId)));

      expect(results.filter((result) => result.reserved)).toHaveLength(1);
      expect(new Set(results.map((result) => result.payment.paymentId)).size).toBe(1);
      const payments = await prisma.payment.findMany({ where: { shopifyOrderId }, include: { attempts: true } });
      expect(payments).toHaveLength(1);
      expect(payments[0].attempts).toHaveLength(1);
    });
  });

  describe("attachInvoice", () => {
    it("NEW の invoice を紐づけると、試行は NEW、Payment は AWAITING_PAYMENT になり version が上がる", async () => {
      const { payment } = await reserve();
      const attemptId = payment.currentAttempt.id;
      const btcpayInvoiceId = randomUUID();

      const result = await repository.attachInvoice({
        attemptId,
        btcpayInvoiceId,
        decide: (state) => applyObservation(state, attemptId, { status: "NEW", received: "NONE" }),
      });

      expect(result).toEqual({
        attached: true,
        payment: {
          ...payment,
          status: "AWAITING_PAYMENT",
          version: 1,
          currentAttempt: { id: attemptId, status: "NEW", btcpayInvoiceId },
        },
        attemptToInvalidate: null,
      });
      // status が変わったので Shopify への反映待ちにする（design.md 4章）
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.paymentId } });
      expect(row.shopifySync).toBe("PENDING");
    });

    it("status もフラグも変わらない紐づけでも version は上げるが、Shopify への反映待ちにはしない", async () => {
      const { payment } = await reserve();
      const attemptId = payment.currentAttempt.id;

      // 管理画面で無効化された、入金のない invoice を回復で紐づけた場合。Payment は CREATING のまま
      const result = await attach(attemptId, { status: "INVALID", received: "NONE" });

      expect(result.payment).toMatchObject({ status: "CREATING", version: 1, currentAttempt: { status: "INVALID" } });
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.paymentId } });
      expect(row.shopifySync).toBe("DONE");
    });

    it("2回目の紐づけは何もせず、先に紐づけた invoice を返す", async () => {
      const { payment } = await reserve();
      const first = await attach(payment.currentAttempt.id);

      const second = await attach(payment.currentAttempt.id);

      expect(second).toEqual({ attached: false, payment: first.payment, attemptToInvalidate: null });
    });

    it("並列に紐づけても、勝つのは1つだけ", async () => {
      const { payment } = await reserve();

      const results = await Promise.all(Array.from({ length: 5 }, () => attach(payment.currentAttempt.id)));

      expect(results.filter((result) => result.attached)).toHaveLength(1);
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.paymentId } });
      expect(row.version).toBe(1);
    });

    it("一部入金のまま期限切れの invoice を紐づけると、UNRESOLVED になり UNDERPAID が付く", async () => {
      const { payment } = await reserve();
      const attemptId = payment.currentAttempt.id;

      const result = await attach(attemptId, { status: "EXPIRED", received: "PARTIAL" });

      expect(result.payment.status).toBe("UNRESOLVED");
      const flags = await prisma.reviewFlag.findMany({ where: { paymentId: payment.paymentId } });
      expect(flags).toMatchObject([{ reason: "UNDERPAID", attemptId, relatedAttemptId: null, resolvedAt: null }]);
      const attempt = await prisma.invoiceAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(attempt).toMatchObject({ status: "EXPIRED", paymentDetected: true });
    });

    it("判定で例外が出たら、紐づけごと取り消され CREATING のまま残る", async () => {
      const { payment } = await reserve();
      const attemptId = payment.currentAttempt.id;

      const failing = repository.attachInvoice({
        attemptId,
        btcpayInvoiceId: randomUUID(),
        decide: () => {
          throw new Error("判定の失敗");
        },
      });

      await expect(failing).rejects.toThrow("判定の失敗");
      expect(await repository.findAttempt(attemptId)).toMatchObject({ status: "CREATING", btcpayInvoiceId: null });
    });
  });

  describe("loadForAttempt と saveObservation", () => {
    // 紐づけ済み（NEW・AWAITING_PAYMENT・version 1）の Payment と、処理中の inbox の行を作る
    async function attachedWithInbox() {
      const { payment } = await reserve();
      const attemptId = payment.currentAttempt.id;
      await attach(attemptId);
      const inboxId = randomUUID();
      await prisma.inbox.create({ data: { id: inboxId, source: "BTCPAY", eventId: randomUUID(), payload: "{}" } });
      return { paymentId: payment.paymentId, attemptId, inboxId };
    }

    async function decideAndSave(attemptId: string, inboxId: string, observation: InvoiceObservation, versionOffset = 0) {
      const loaded = await repository.loadForAttempt(attemptId);
      if (!loaded) throw new Error("試行がない");
      const result = applyObservation(loaded.state, attemptId, observation);
      return repository.saveObservation({
        paymentId: loaded.paymentId,
        expectedVersion: loaded.version + versionOffset,
        attemptId,
        result,
        inboxId,
      });
    }

    it("試行の Payment の状態・version・紐づいた invoice を返す。なければ null", async () => {
      const { paymentId, attemptId } = await attachedWithInbox();

      const loaded = await repository.loadForAttempt(attemptId);

      expect(loaded).toMatchObject({
        paymentId,
        version: 1,
        btcpayInvoiceId: expect.any(String),
        state: {
          status: "AWAITING_PAYMENT",
          currentAttemptId: attemptId,
          attempts: [{ id: attemptId, status: "NEW", invalidatedByUs: false, paymentDetected: false }],
          flags: [],
        },
      });
      expect(await repository.loadForAttempt(randomUUID())).toBeNull();
    });

    it("保存すると、試行・Payment・フラグを更新し、version を上げ、同じ commit で inbox の行を DONE にする", async () => {
      const { paymentId, attemptId, inboxId } = await attachedWithInbox();

      expect(await decideAndSave(attemptId, inboxId, { status: "PROCESSING", received: "OVER" })).toEqual({ saved: true });

      const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { reviewFlags: true } });
      expect(row).toMatchObject({ status: "CONFIRMING", version: 2, shopifySync: "PENDING" });
      expect(row.reviewFlags).toMatchObject([{ reason: "OVERPAID", attemptId }]);
      expect(await prisma.invoiceAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({
        status: "PROCESSING",
        paymentDetected: true,
      });
      expect(await prisma.inbox.findUniqueOrThrow({ where: { id: inboxId } })).toMatchObject({ status: "DONE" });
    });

    it("試行だけが変わる場合も version を上げるが、Shopify への反映待ちにはしない", async () => {
      const { paymentId, attemptId, inboxId } = await attachedWithInbox();
      await prisma.payment.update({ where: { id: paymentId }, data: { shopifySync: "DONE" } });

      // NEW のままの一部入金。status もフラグも変わらない
      expect(await decideAndSave(attemptId, inboxId, { status: "NEW", received: "PARTIAL" })).toEqual({ saved: true });

      const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(row).toMatchObject({ status: "AWAITING_PAYMENT", version: 2, shopifySync: "DONE" });
      expect(await prisma.invoiceAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({
        paymentDetected: true,
      });
    });

    it("読んだ後に version が変わっていたら何も保存せず、inbox の行も PENDING のまま", async () => {
      const { paymentId, attemptId, inboxId } = await attachedWithInbox();

      // 読んだ version と違う値を渡し、別の処理が先に更新した状況にする
      const result = await decideAndSave(attemptId, inboxId, { status: "PROCESSING", received: "OVER" }, -1);

      expect(result).toEqual({ saved: false });
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { reviewFlags: true } });
      expect(row).toMatchObject({ status: "AWAITING_PAYMENT", version: 1, reviewFlags: [] });
      expect(await prisma.invoiceAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ status: "NEW" });
      expect(await prisma.inbox.findUniqueOrThrow({ where: { id: inboxId } })).toMatchObject({ status: "PENDING" });
    });
  });

  describe("findAttempt", () => {
    it("試行と、その Payment の shopifyOrderId を返す。なければ null", async () => {
      const { payment } = await reserve();

      expect(await repository.findAttempt(payment.currentAttempt.id)).toEqual({
        attemptId: payment.currentAttempt.id,
        paymentId: payment.paymentId,
        shopifyOrderId: payment.shopifyOrderId,
        status: "CREATING",
        btcpayInvoiceId: null,
      });
      expect(await repository.findAttempt(randomUUID())).toBeNull();
    });
  });

  describe("Shopify への反映（loadForSync・markSynced・recordSyncError）", () => {
    // 紐づけ済み（AWAITING_PAYMENT・version 1）の Payment。紐づけで status が変わるので shopifySync は PENDING
    async function pendingSync() {
      const { payment } = await reserve();
      await attach(payment.currentAttempt.id);
      return { paymentId: payment.paymentId, attemptId: payment.currentAttempt.id, shopifyOrderId: payment.shopifyOrderId };
    }

    it("ショップ・状態・version と、未対応のフラグの理由だけを返す。なければ null", async () => {
      const { paymentId, attemptId, shopifyOrderId } = await pendingSync();
      await prisma.reviewFlag.createMany({
        data: [
          { id: randomUUID(), paymentId, attemptId, reason: "OVERPAID" },
          { id: randomUUID(), paymentId, attemptId, reason: "UNDERPAID", resolvedAt: new Date() },
        ],
      });

      expect(await repository.loadForSync(paymentId)).toEqual({
        paymentId,
        shop: "test-shop.myshopify.com",
        shopifyOrderId,
        status: "AWAITING_PAYMENT",
        version: 1,
        shopifySync: "PENDING",
        unresolvedReasons: ["OVERPAID"],
      });
      expect(await repository.loadForSync(randomUUID())).toBeNull();
    });

    it("読んだ version のままなら DONE にし、記録した失敗を消す", async () => {
      const { paymentId } = await pendingSync();
      await repository.recordSyncError(paymentId, "一時的な失敗");
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({
        shopifySync: "PENDING",
        shopifySyncError: "一時的な失敗",
      });

      expect(await repository.markSynced(paymentId, 1)).toBe(true);
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({
        shopifySync: "DONE",
        shopifySyncError: null,
        version: 1,
      });
    });

    it("反映中に version が変わっていたら、PENDING のまま残す", async () => {
      const { paymentId } = await pendingSync();
      await prisma.payment.update({ where: { id: paymentId }, data: { version: { increment: 1 } } });

      expect(await repository.markSynced(paymentId, 1)).toBe(false);
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({ shopifySync: "PENDING" });
    });

    it("すでに DONE なら、失敗を記録しない", async () => {
      const { paymentId } = await pendingSync();
      await repository.markSynced(paymentId, 1);

      await repository.recordSyncError(paymentId, "遅れて届いた失敗");
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({
        shopifySync: "DONE",
        shopifySyncError: null,
      });
    });
  });

  describe("markInvalidatedByUs と saveReissue", () => {
    it("無効化の意図を記録し、version を上げる。version が違えば何もしない", async () => {
      const { payment } = await reserve();
      const attemptId = payment.currentAttempt.id;
      await attach(attemptId);

      expect(await repository.markInvalidatedByUs({ paymentId: payment.paymentId, expectedVersion: 0, attemptId })).toBe(false);
      expect(await repository.markInvalidatedByUs({ paymentId: payment.paymentId, expectedVersion: 1, attemptId })).toBe(true);

      expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.paymentId } })).toMatchObject({ version: 2 });
      expect(await prisma.invoiceAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({
        invalidatedByUs: true,
        invalidatedAt: expect.any(Date),
      });
    });

    it("再発行は、新しい試行を CREATING で作ってポインタを付け替える。version が違えば何もしない", async () => {
      const { payment } = await reserve();
      await attach(payment.currentAttempt.id, { status: "EXPIRED", received: "NONE" });
      const newAttemptId = randomUUID();
      const loaded = await repository.loadForAttempt(payment.currentAttempt.id);
      const reissued = reissue(loaded!.state, newAttemptId);
      if (!reissued.ok) throw new Error("EXPIRED ではない");
      const save = (expectedVersion: number) =>
        repository.saveReissue({ paymentId: payment.paymentId, expectedVersion, state: reissued.state });

      const stale = await save(0);
      expect(stale).toMatchObject({ saved: false, payment: { status: "EXPIRED" } });

      const saved = await save(1);
      expect(saved).toMatchObject({
        saved: true,
        payment: { status: "CREATING", version: 2, currentAttempt: { id: newAttemptId, status: "CREATING", btcpayInvoiceId: null } },
      });
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.paymentId } })).toMatchObject({
        shopifySync: "PENDING",
      });
    });
  });
});
