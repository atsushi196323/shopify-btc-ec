import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureSqlite, readPragmas } from "../../../src/adapters/db/sqlite";
import { createTestDb } from "../../helpers/test-db";

// design.md 3章: SQLite は WAL・busy_timeout・foreign_keys = ON で使う
describe("configureSqlite", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    ({ prisma, cleanup } = createTestDb());
  });

  afterAll(async () => {
    await cleanup();
  });

  it("WAL にし、busy_timeout と foreign_keys が効いていることを確かめる", async () => {
    expect((await readPragmas(prisma)).journalMode).toBe("delete");

    const pragmas = await configureSqlite(prisma);

    expect(pragmas).toEqual({ journalMode: "wal", busyTimeoutMs: 5000, foreignKeys: true });
  });

  it("何度呼んでも同じ設定になる", async () => {
    await configureSqlite(prisma);

    expect(await readPragmas(prisma)).toEqual({ journalMode: "wal", busyTimeoutMs: 5000, foreignKeys: true });
  });
});
