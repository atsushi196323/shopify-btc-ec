// InboxRepository を Prisma（SQLite）で実装する（ADR 8）。
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { TRANSACTION_OPTIONS } from "./sqlite";
import type { BtcpayEventInput, InboxEvent, InboxRepository, InboxStatus } from "../../application/ports/inbox-repository";

// payload には署名を検証したイベントのうち、使う項目だけを JSON で保存する
type StoredBtcpayEvent = { type: string; invoiceId: string };

export class PrismaInboxRepository implements InboxRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async saveBtcpayEvent({ eventId, type, invoiceId }: BtcpayEventInput) {
    const payload: StoredBtcpayEvent = { type, invoiceId };
    try {
      const row = await this.prisma.inbox.create({
        data: { id: randomUUID(), source: "BTCPAY", eventId, payload: JSON.stringify(payload) },
      });
      return { inboxId: row.id, duplicate: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.inbox.findUniqueOrThrow({
          where: { source_eventId: { source: "BTCPAY", eventId } },
        });
        return { inboxId: existing.id, duplicate: true };
      }
      throw error;
    }
  }

  async find(inboxId: string): Promise<InboxEvent | null> {
    const row = await this.prisma.inbox.findUnique({ where: { id: inboxId } });
    if (!row) return null;
    const payload = JSON.parse(row.payload) as StoredBtcpayEvent;
    return { inboxId: row.id, status: row.status, invoiceId: payload.invoiceId, attempts: row.attempts };
  }

  async markDone(inboxId: string): Promise<void> {
    await this.prisma.inbox.update({ where: { id: inboxId }, data: { status: "DONE" } });
  }

  async recordFailure(inboxId: string, error: string, maxAttempts: number): Promise<InboxStatus> {
    return this.prisma.$transaction(async (tx) => {
      // 別の処理が先に DONE にした行は書き換えない
      await tx.inbox.updateMany({
        where: { id: inboxId, status: "PENDING" },
        data: { attempts: { increment: 1 }, lastError: error },
      });
      const row = await tx.inbox.findUniqueOrThrow({ where: { id: inboxId } });
      if (row.status !== "PENDING" || row.attempts < maxAttempts) return row.status;
      await tx.inbox.update({ where: { id: inboxId }, data: { status: "FAILED" } });
      return "FAILED";
    }, TRANSACTION_OPTIONS);
  }
}
