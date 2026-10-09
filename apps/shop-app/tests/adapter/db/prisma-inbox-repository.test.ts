import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaInboxRepository } from "../../../src/adapters/db/prisma-inbox-repository";
import { createTestDb } from "../../helpers/test-db";

// inbox（ADR 8）。受信したイベントの保存と、再処理の回数の記録
describe("PrismaInboxRepository", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;
  let inbox: PrismaInboxRepository;

  beforeAll(() => {
    ({ prisma, cleanup } = createTestDb());
    inbox = new PrismaInboxRepository(prisma);
  });

  afterAll(async () => {
    await cleanup();
  });

  const save = (eventId = randomUUID()) => inbox.saveBtcpayEvent({ eventId, type: "InvoiceSettled", invoiceId: "inv-1" });

  it("保存した行は PENDING で、invoice ID を読める", async () => {
    const { inboxId, duplicate } = await save();

    expect(duplicate).toBe(false);
    expect(await inbox.find(inboxId)).toEqual({ inboxId, status: "PENDING", invoiceId: "inv-1", attempts: 0 });
    expect(await inbox.find(randomUUID())).toBeNull();
  });

  it("同じ配信 ID は2件目を作らず、既存の行を返す", async () => {
    const eventId = randomUUID();
    const first = await save(eventId);

    const second = await save(eventId);

    expect(second).toEqual({ inboxId: first.inboxId, duplicate: true });
    expect(await prisma.inbox.count({ where: { eventId } })).toBe(1);
  });

  it("失敗を記録すると回数が増え、上限に達したら FAILED にする", async () => {
    const { inboxId } = await save();

    expect(await inbox.recordFailure(inboxId, "1回目", 3)).toBe("PENDING");
    expect(await inbox.recordFailure(inboxId, "2回目", 3)).toBe("PENDING");
    expect(await inbox.recordFailure(inboxId, "3回目", 3)).toBe("FAILED");

    const row = await prisma.inbox.findUniqueOrThrow({ where: { id: inboxId } });
    expect(row).toMatchObject({ status: "FAILED", attempts: 3, lastError: "3回目" });
  });

  it("DONE の行には失敗を記録しない", async () => {
    const { inboxId } = await save();
    await inbox.markDone(inboxId);

    expect(await inbox.recordFailure(inboxId, "遅れて届いた失敗", 1)).toBe("DONE");

    expect(await prisma.inbox.findUniqueOrThrow({ where: { id: inboxId } })).toMatchObject({
      status: "DONE",
      attempts: 0,
      lastError: null,
    });
  });
});
