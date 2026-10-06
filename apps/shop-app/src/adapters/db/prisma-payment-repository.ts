// PaymentRepository を Prisma（SQLite）で実装する。
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AttachInvoiceInput,
  AttachInvoiceResult,
  AttemptSnapshot,
  PaymentRepository,
  PaymentSnapshot,
  ReserveInput,
  ReserveResult,
} from "../../application/ports/payment-repository";
import type { PaymentState } from "../../domain/payment";

const withCurrentAttempt = { currentAttempt: true } satisfies Prisma.PaymentInclude;
type PaymentWithCurrentAttempt = Prisma.PaymentGetPayload<{ include: typeof withCurrentAttempt }>;

// 接続が1本なので（ADR 7）、トランザクションは開始を待つ列に並ぶ。Prisma の既定（2秒）では、重なったときに待たずに失敗するので、
// 通常のクエリの接続待ち（pool_timeout の既定 10 秒）に揃える
const TRANSACTION_OPTIONS = { maxWait: 10_000 } as const;

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByShopifyOrderId(shopifyOrderId: string): Promise<PaymentSnapshot | null> {
    const payment = await this.prisma.payment.findUnique({ where: { shopifyOrderId }, include: withCurrentAttempt });
    return payment ? toSnapshot(payment) : null;
  }

  async findAttempt(attemptId: string): Promise<AttemptSnapshot | null> {
    const attempt = await this.prisma.invoiceAttempt.findUnique({ where: { id: attemptId }, include: { payment: true } });
    if (!attempt) return null;
    return {
      attemptId: attempt.id,
      paymentId: attempt.paymentId,
      shopifyOrderId: attempt.payment.shopifyOrderId,
      status: attempt.status,
      btcpayInvoiceId: attempt.btcpayInvoiceId,
    };
  }

  async reserve({ paymentId, attemptId, shopifyOrderId }: ReserveInput): Promise<ReserveResult> {
    try {
      const payment = await this.prisma.$transaction(async (tx) => {
        await tx.payment.create({ data: { id: paymentId, shopifyOrderId } });
        await tx.invoiceAttempt.create({ data: { id: attemptId, paymentId } });
        return tx.payment.update({
          where: { id: paymentId },
          data: { currentAttemptId: attemptId },
          include: withCurrentAttempt,
        });
      }, TRANSACTION_OPTIONS);
      return { reserved: true, payment: toSnapshot(payment) };
    } catch (error) {
      // shopifyOrderId の UNIQUE に負けた。勝った側の行は commit 済みなので、そのまま読んで返す
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.findByShopifyOrderId(shopifyOrderId);
        if (existing) return { reserved: false, payment: existing };
      }
      throw error;
    }
  }

  async attachInvoice({ attemptId, btcpayInvoiceId, decide }: AttachInvoiceInput): Promise<AttachInvoiceResult> {
    return this.prisma.$transaction(async (tx) => {
      // 最初に書き込んで書き込みロックを取る。SQLite は書き込みを直列にするので、この後の読み取りと更新の間に別の更新は入らない。
      // 読み取りから始めると、後から書き込みに切り替えるときに busy_timeout を待たずに失敗することがある
      const claimed = await tx.invoiceAttempt.updateMany({
        where: { id: attemptId, status: "CREATING", btcpayInvoiceId: null },
        data: { btcpayInvoiceId },
      });
      const attempt = await tx.invoiceAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      if (claimed.count === 0) {
        return { attached: false, payment: toSnapshot(await findPayment(tx, attempt.paymentId)) };
      }

      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: attempt.paymentId },
        include: { attempts: true, reviewFlags: true },
      });
      if (!payment.currentAttemptId) throw new Error(`Payment ${payment.id} のポインタが NULL`);
      const state: PaymentState = {
        status: payment.status,
        currentAttemptId: payment.currentAttemptId,
        attempts: payment.attempts.map((a) => ({
          id: a.id,
          status: a.status,
          invalidatedByUs: a.invalidatedByUs,
          paymentDetected: a.paymentDetected,
        })),
        flags: payment.reviewFlags.map((flag) => ({
          reason: flag.reason,
          attemptId: flag.attemptId,
          relatedAttemptId: flag.relatedAttemptId,
          resolved: flag.resolvedAt !== null,
        })),
      };
      const result = decide(state);
      const next = result.state.attempts.find((a) => a.id === attemptId);
      if (!next) throw new Error(`判定の結果に試行 ${attemptId} がない`);

      await tx.invoiceAttempt.update({
        where: { id: attemptId },
        data: { status: next.status, paymentDetected: next.paymentDetected },
      });
      // status かフラグが変わったときだけ Payment を更新する。その条件はドメインの needsShopifySync に任せる
      if (result.needsShopifySync) {
        // 書き込みロックを持っているので競合は起きないが、version の約束（読んだ値からの +1）を条件でも守る
        const updated = await tx.payment.updateMany({
          where: { id: payment.id, version: payment.version },
          data: {
            status: result.state.status,
            version: { increment: 1 },
            shopifySync: "PENDING",
          },
        });
        if (updated.count !== 1) throw new Error(`Payment ${payment.id} の version が読んだ後に変わった`);
        await tx.reviewFlag.createMany({
          data: result.newFlags.map((flag) => ({ id: randomUUID(), paymentId: payment.id, ...flag })),
        });
      }
      return { attached: true, payment: toSnapshot(await findPayment(tx, payment.id)) };
    }, TRANSACTION_OPTIONS);
  }
}

function findPayment(tx: Prisma.TransactionClient, paymentId: string): Promise<PaymentWithCurrentAttempt> {
  return tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: withCurrentAttempt });
}

// commit の後はポインタが NULL にならない（design.md 3章）。NULL なら不変条件が破れているので止める
function toSnapshot(payment: PaymentWithCurrentAttempt): PaymentSnapshot {
  const attempt = payment.currentAttempt;
  if (!attempt) throw new Error(`Payment ${payment.id} のポインタが NULL`);
  return {
    paymentId: payment.id,
    shopifyOrderId: payment.shopifyOrderId,
    status: payment.status,
    version: payment.version,
    currentAttempt: { id: attempt.id, status: attempt.status, btcpayInvoiceId: attempt.btcpayInvoiceId },
  };
}
