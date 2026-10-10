import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../helpers/test-db";

// ADR 7: Payment.currentAttemptId は、同じ Payment の試行しか指せない（複合外部キー）
describe("Payment.currentAttemptId の複合外部キー", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    ({ prisma, cleanup } = createTestDb());
  });

  afterAll(async () => {
    await cleanup();
  });

  it("ポインタが NULL の Payment は作れる", async () => {
    const payment = await prisma.payment.create({
      data: { id: randomUUID(), shop: "test-shop.myshopify.com", shopifyOrderId: randomUUID() },
    });

    expect(payment.currentAttemptId).toBeNull();
  });

  it("Payment の作成 → 試行の作成 → ポインタの設定を、1つのトランザクションで行える", async () => {
    const paymentId = randomUUID();
    const attemptId = randomUUID();

    await prisma.$transaction(async (tx) => {
      await tx.payment.create({ data: { id: paymentId, shop: "test-shop.myshopify.com", shopifyOrderId: randomUUID() } });
      await tx.invoiceAttempt.create({ data: { id: attemptId, paymentId } });
      await tx.payment.update({ where: { id: paymentId }, data: { currentAttemptId: attemptId } });
    });

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.currentAttemptId).toBe(attemptId);
  });

  it("別の Payment の試行を指すと、外部キー違反で失敗する", async () => {
    // Prisma が SQLite の外部キーの検査を有効にしていることを、先に直接確かめる
    const [pragma] = await prisma.$queryRaw<{ foreign_keys: bigint }[]>`PRAGMA foreign_keys`;
    expect(Number(pragma.foreign_keys)).toBe(1);

    const paymentA = await prisma.payment.create({ data: { id: randomUUID(), shop: "test-shop.myshopify.com", shopifyOrderId: randomUUID() } });
    const paymentB = await prisma.payment.create({ data: { id: randomUUID(), shop: "test-shop.myshopify.com", shopifyOrderId: randomUUID() } });
    const attemptOfB = await prisma.invoiceAttempt.create({ data: { id: randomUUID(), paymentId: paymentB.id } });

    const pointToOthersAttempt = prisma.payment.update({
      where: { id: paymentA.id },
      data: { currentAttemptId: attemptOfB.id },
    });

    await expect(pointToOthersAttempt).rejects.toSatisfy(
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003",
    );
    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: paymentA.id } });
    expect(unchanged.currentAttemptId).toBeNull();
  });
});
