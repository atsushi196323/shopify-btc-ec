import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPaymentRepository } from "../../../src/adapters/db/prisma-payment-repository";
import { applyObservation, type InvoiceObservation } from "../../../src/domain/payment";
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
    repository.reserve({ paymentId: randomUUID(), attemptId: randomUUID(), shopifyOrderId });

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

      const result = await repository.reserve({ paymentId, attemptId, shopifyOrderId });

      expect(result).toEqual({
        reserved: true,
        payment: {
          paymentId,
          shopifyOrderId,
          status: "CREATING",
          version: 0,
          currentAttempt: { id: attemptId, status: "CREATING", btcpayInvoiceId: null },
        },
      });
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
      expect(row).toMatchObject({ currentAttemptId: attemptId, shopifySync: "DONE" });
    });

    it("同じ shopifyOrderId では負け、既存の Payment を返す。負けた側の行は残らない", async () => {
      const first = await reserve();
      const loserAttemptId = randomUUID();

      const second = await repository.reserve({
        paymentId: randomUUID(),
        attemptId: loserAttemptId,
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
      });
      // status が変わったので Shopify への反映待ちにする（design.md 4章）
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.paymentId } });
      expect(row.shopifySync).toBe("PENDING");
    });

    it("2回目の紐づけは何もせず、先に紐づけた invoice を返す", async () => {
      const { payment } = await reserve();
      const first = await attach(payment.currentAttempt.id);

      const second = await attach(payment.currentAttempt.id);

      expect(second).toEqual({ attached: false, payment: first.payment });
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
});
