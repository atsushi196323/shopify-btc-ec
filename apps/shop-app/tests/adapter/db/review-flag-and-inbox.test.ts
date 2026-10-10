import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../helpers/test-db";
import { TEST_SHOP } from "../../helpers/orders";

function hasCode(code: string) {
  return (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

describe("ReviewFlag と Inbox の制約", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    ({ prisma, cleanup } = createTestDb());
  });

  afterAll(async () => {
    await cleanup();
  });

  // design.md 3章の作成順序で、Payment と試行を1つ作る
  async function createPaymentWithAttempt() {
    const paymentId = randomUUID();
    const attemptId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.payment.create({ data: { id: paymentId, shop: TEST_SHOP, shopifyOrderId: randomUUID() } });
      await tx.invoiceAttempt.create({ data: { id: attemptId, paymentId } });
      await tx.payment.update({ where: { id: paymentId }, data: { currentAttemptId: attemptId } });
    });
    return { paymentId, attemptId };
  }

  it("既定値: Payment は CREATING・version 0・shopifySync DONE、試行は CREATING", async () => {
    const { paymentId, attemptId } = await createPaymentWithAttempt();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const attempt = await prisma.invoiceAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    expect(payment).toMatchObject({ status: "CREATING", version: 0, shopifySync: "DONE" });
    expect(attempt).toMatchObject({ status: "CREATING", btcpayInvoiceId: null, invalidatedByUs: false });
  });

  it("不変条件5: 同じ (paymentId, reason, attemptId) のフラグは2件目を作れない", async () => {
    const { paymentId, attemptId } = await createPaymentWithAttempt();
    await prisma.reviewFlag.create({
      data: { id: randomUUID(), paymentId, reason: "LATE_PAYMENT", attemptId, resolvedAt: new Date() },
    });

    const again = prisma.reviewFlag.create({
      data: { id: randomUUID(), paymentId, reason: "LATE_PAYMENT", attemptId },
    });

    await expect(again).rejects.toSatisfy(hasCode("P2002"));
  });

  it("フラグは別の Payment の試行を指せない（attemptId・relatedAttemptId とも）", async () => {
    const a = await createPaymentWithAttempt();
    const b = await createPaymentWithAttempt();

    const othersAttempt = prisma.reviewFlag.create({
      data: { id: randomUUID(), paymentId: a.paymentId, reason: "UNDERPAID", attemptId: b.attemptId },
    });
    const othersRelated = prisma.reviewFlag.create({
      data: {
        id: randomUUID(),
        paymentId: a.paymentId,
        reason: "DOUBLE_PAYMENT",
        attemptId: a.attemptId,
        relatedAttemptId: b.attemptId,
      },
    });

    await expect(othersAttempt).rejects.toSatisfy(hasCode("P2003"));
    await expect(othersRelated).rejects.toSatisfy(hasCode("P2003"));
  });

  it("同じ Payment の2つの試行で DOUBLE_PAYMENT を作れる", async () => {
    const { paymentId, attemptId: oldAttemptId } = await createPaymentWithAttempt();
    const newAttemptId = randomUUID();
    await prisma.invoiceAttempt.create({ data: { id: newAttemptId, paymentId } });

    const flag = await prisma.reviewFlag.create({
      data: {
        id: randomUUID(),
        paymentId,
        reason: "DOUBLE_PAYMENT",
        attemptId: newAttemptId,
        relatedAttemptId: oldAttemptId,
      },
    });

    expect(flag.relatedAttemptId).toBe(oldAttemptId);
  });

  it("Inbox は同じ (source, eventId) を2回保存できない", async () => {
    const eventId = randomUUID();
    await prisma.inbox.create({ data: { id: randomUUID(), source: "BTCPAY", eventId, payload: "{}" } });

    const duplicate = prisma.inbox.create({ data: { id: randomUUID(), source: "BTCPAY", eventId, payload: "{}" } });

    await expect(duplicate).rejects.toSatisfy(hasCode("P2002"));
  });
});
