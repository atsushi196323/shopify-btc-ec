// PaymentRepository を Prisma（SQLite）で実装する。
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AttachInvoiceInput,
  AttachInvoiceResult,
  AttemptSnapshot,
  InvoiceToReconcile,
  MarkInvalidatedInput,
  OrphanAttempt,
  PaymentForAttempt,
  PaymentForSync,
  PaymentRepository,
  PaymentSnapshot,
  ReserveInput,
  ReserveResult,
  SaveObservationInput,
  SaveReissueInput,
} from "../../application/ports/payment-repository";
import type { ObservationResult, PaymentState } from "../../domain/payment";
import { TRANSACTION_OPTIONS } from "./sqlite";

const withCurrentAttempt = { currentAttempt: true } satisfies Prisma.PaymentInclude;
type PaymentWithCurrentAttempt = Prisma.PaymentGetPayload<{ include: typeof withCurrentAttempt }>;
const withState = { attempts: true, reviewFlags: true } satisfies Prisma.PaymentInclude;
type PaymentWithState = Prisma.PaymentGetPayload<{ include: typeof withState }>;

// saveObservation で version が変わっていたことを伝え、トランザクションを巻き戻す
class VersionConflict extends Error {}

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

  async reserve({ paymentId, attemptId, shop, shopifyOrderId }: ReserveInput): Promise<ReserveResult> {
    try {
      const payment = await this.prisma.$transaction(async (tx) => {
        await tx.payment.create({ data: { id: paymentId, shop, shopifyOrderId } });
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
        return {
          attached: false,
          payment: toSnapshot(await findPayment(tx, attempt.paymentId)),
          attemptToInvalidate: null,
        };
      }

      const payment = await tx.payment.findUniqueOrThrow({ where: { id: attempt.paymentId }, include: withState });
      const result = decide(toPaymentState(payment));
      // 紐づけは試行を必ず変えるので、version は常に上げる（ADR 6 の直列化）。
      // 書き込みロックを持っているので競合は起きないが、version の約束（読んだ値からの +1）を条件でも守る
      if (!(await writeObservation(tx, payment.id, payment.version, attemptId, result))) {
        throw new Error(`Payment ${payment.id} の version が読んだ後に変わった`);
      }
      return {
        attached: true,
        payment: toSnapshot(await findPayment(tx, payment.id)),
        attemptToInvalidate: result.attemptToInvalidate,
      };
    }, TRANSACTION_OPTIONS);
  }

  async loadForAttempt(attemptId: string): Promise<PaymentForAttempt | null> {
    const attempt = await this.prisma.invoiceAttempt.findUnique({
      where: { id: attemptId },
      include: { payment: { include: withState } },
    });
    if (!attempt) return null;
    return {
      paymentId: attempt.paymentId,
      version: attempt.payment.version,
      state: toPaymentState(attempt.payment),
      btcpayInvoiceId: attempt.btcpayInvoiceId,
    };
  }

  async saveObservation({ paymentId, expectedVersion, attemptId, result, inboxId }: SaveObservationInput) {
    try {
      await this.prisma.$transaction(async (tx) => {
        if (!(await writeObservation(tx, paymentId, expectedVersion, attemptId, result))) throw new VersionConflict();
        if (inboxId) await tx.inbox.update({ where: { id: inboxId }, data: { status: "DONE" } });
      }, TRANSACTION_OPTIONS);
      return { saved: true };
    } catch (error) {
      if (error instanceof VersionConflict) return { saved: false };
      throw error;
    }
  }

  async markInvalidatedByUs({ paymentId, expectedVersion, attemptId }: MarkInvalidatedInput): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // 最初に書き込んでロックを取る（attachInvoice と同じ理由）。invalidatedByUs は判定（ADR 6）に効くので version を上げる
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, version: expectedVersion },
        data: { version: { increment: 1 } },
      });
      if (updated.count === 0) return false;
      await tx.invoiceAttempt.update({
        where: { id: attemptId, paymentId },
        data: { invalidatedByUs: true, invalidatedAt: new Date() },
      });
      return true;
    }, TRANSACTION_OPTIONS);
  }

  async saveReissue({ paymentId, expectedVersion, state }: SaveReissueInput) {
    const next = state.attempts.find((a) => a.id === state.currentAttemptId);
    if (!next || next.status !== "CREATING") {
      throw new Error(`再発行の結果の現在の試行 ${state.currentAttemptId} が、新しい CREATING の試行ではない`);
    }
    return this.prisma.$transaction(async (tx) => {
      // 最初に書き込んでロックを取る。試行の作成とポインタの付け替えは、同じトランザクションで行う（ADR 7）。
      // status が変わるので、ほかの遷移と同じく Shopify への反映待ちにする（design.md 4章「Shopify への反映」の1）
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, version: expectedVersion },
        data: { status: state.status, version: { increment: 1 }, shopifySync: "PENDING" },
      });
      if (updated.count === 0) return { saved: false, payment: toSnapshot(await findPayment(tx, paymentId)) };
      await tx.invoiceAttempt.create({
        data: {
          id: next.id,
          paymentId,
          status: next.status,
          invalidatedByUs: next.invalidatedByUs,
          paymentDetected: next.paymentDetected,
        },
      });
      const payment = await tx.payment.update({
        where: { id: paymentId },
        data: { currentAttemptId: next.id },
        include: withCurrentAttempt,
      });
      return { saved: true, payment: toSnapshot(payment) };
    }, TRANSACTION_OPTIONS);
  }

  async loadForSync(paymentId: string): Promise<PaymentForSync | null> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { reviewFlags: { where: { resolvedAt: null } } },
    });
    if (!payment) return null;
    return {
      paymentId: payment.id,
      shop: payment.shop,
      shopifyOrderId: payment.shopifyOrderId,
      status: payment.status,
      version: payment.version,
      shopifySync: payment.shopifySync,
      unresolvedReasons: [...new Set(payment.reviewFlags.map((flag) => flag.reason))],
    };
  }

  async markSynced(paymentId: string, version: number): Promise<boolean> {
    const updated = await this.prisma.payment.updateMany({
      where: { id: paymentId, version, shopifySync: "PENDING" },
      data: { shopifySync: "DONE", shopifySyncError: null },
    });
    return updated.count === 1;
  }

  // version は条件にしない。反映中に別の変更が入っていても、失敗の内容は次の反映で DONE になるまで残しておく
  async recordSyncError(paymentId: string, error: string): Promise<void> {
    await this.prisma.payment.updateMany({
      where: { id: paymentId, shopifySync: "PENDING" },
      data: { shopifySyncError: error },
    });
  }

  async findOrphanAttempts(createdBefore: Date): Promise<OrphanAttempt[]> {
    const attempts = await this.prisma.invoiceAttempt.findMany({
      where: { status: "CREATING", btcpayInvoiceId: null, createdAt: { lte: createdBefore } },
      orderBy: { createdAt: "asc" },
      select: { id: true, payment: { select: { shop: true } } },
    });
    return attempts.map((attempt) => ({ attemptId: attempt.id, shop: attempt.payment.shop }));
  }

  async findUnsettledInvoices(): Promise<InvoiceToReconcile[]> {
    return toReconcile(
      await this.prisma.invoiceAttempt.findMany({
        where: { status: { in: ["NEW", "PROCESSING"] }, btcpayInvoiceId: { not: null } },
        orderBy: { createdAt: "asc" },
      }),
    );
  }

  // 期限切れの時刻は列に持たず、updatedAt で数える。EXPIRED は終端なので、その後の更新（期限後の入金の記録など）は
  // updatedAt を後ろにずらすだけで、監視期間が延びる方向にしかずれない
  async findExpiredInvoices(expiredSince: Date): Promise<InvoiceToReconcile[]> {
    return toReconcile(
      await this.prisma.invoiceAttempt.findMany({
        where: { status: "EXPIRED", updatedAt: { gte: expiredSince }, btcpayInvoiceId: { not: null } },
        orderBy: { updatedAt: "asc" },
      }),
    );
  }

  async findAttemptsToInvalidate(): Promise<string[]> {
    // 現在の試行（ポインタが指す試行）だけを見る。ドメインの attemptToInvalidate と同じ条件
    const payments = await this.prisma.payment.findMany({
      where: { status: "UNRESOLVED", currentAttempt: { status: "NEW" } },
      orderBy: { createdAt: "asc" },
      select: { currentAttemptId: true },
    });
    return payments.flatMap((payment) => (payment.currentAttemptId ? [payment.currentAttemptId] : []));
  }

  async findInvalidatedInvoices(invalidatedSince: Date): Promise<InvoiceToReconcile[]> {
    return toReconcile(
      await this.prisma.invoiceAttempt.findMany({
        where: { invalidatedByUs: true, invalidatedAt: { gte: invalidatedSince }, btcpayInvoiceId: { not: null } },
        orderBy: { invalidatedAt: "asc" },
      }),
    );
  }

  async findPendingSync(): Promise<string[]> {
    const payments = await this.prisma.payment.findMany({
      where: { shopifySync: "PENDING" },
      orderBy: { updatedAt: "asc" },
      select: { id: true },
    });
    return payments.map((payment) => payment.id);
  }
}

// 判定の結果を保存する。最初の書き込み（Payment の version 付きの更新）でロックを取る（attachInvoice のコメントと同じ理由）。
// 試行だけが変わる場合（NEW のままの一部入金など）も version を上げる。ほかの試行の判定（DOUBLE_PAYMENT）がこの試行の入金を見るため。
// Shopify への反映待ちにするのは、status かフラグが変わったときだけ（ドメインの needsShopifySync）。false は version の競合
async function writeObservation(
  tx: Prisma.TransactionClient,
  paymentId: string,
  expectedVersion: number,
  attemptId: string,
  result: ObservationResult,
): Promise<boolean> {
  const next = result.state.attempts.find((a) => a.id === attemptId);
  if (!next) throw new Error(`判定の結果に試行 ${attemptId} がない`);
  const updated = await tx.payment.updateMany({
    where: { id: paymentId, version: expectedVersion },
    data: {
      status: result.state.status,
      version: { increment: 1 },
      ...(result.needsShopifySync ? { shopifySync: "PENDING" as const } : {}),
    },
  });
  if (updated.count === 0) return false;
  await tx.invoiceAttempt.update({
    where: { id: attemptId },
    data: { status: next.status, paymentDetected: next.paymentDetected },
  });
  await tx.reviewFlag.createMany({
    data: result.newFlags.map((flag) => ({ id: randomUUID(), paymentId, ...flag })),
  });
  return true;
}

// btcpayInvoiceId が NULL でない試行だけを渡す（クエリの条件で絞っている）
function toReconcile(attempts: { id: string; btcpayInvoiceId: string | null }[]): InvoiceToReconcile[] {
  return attempts.flatMap((a) => (a.btcpayInvoiceId ? [{ attemptId: a.id, btcpayInvoiceId: a.btcpayInvoiceId }] : []));
}

function toPaymentState(payment: PaymentWithState): PaymentState {
  if (!payment.currentAttemptId) throw new Error(`Payment ${payment.id} のポインタが NULL`);
  return {
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
    shop: payment.shop,
    shopifyOrderId: payment.shopifyOrderId,
    status: payment.status,
    version: payment.version,
    currentAttempt: { id: attempt.id, status: attempt.status, btcpayInvoiceId: attempt.btcpayInvoiceId },
  };
}
