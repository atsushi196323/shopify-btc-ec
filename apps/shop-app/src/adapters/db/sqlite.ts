// SQLite の設定（design.md 3章）。WAL・busy_timeout・foreign_keys = ON で使う。
import type { PrismaClient } from "@prisma/client";

// 接続が1本なので（ADR 7）、トランザクションは開始を待つ列に並ぶ。Prisma の既定（2秒）では、重なったときに待たずに失敗するので、
// 通常のクエリの接続待ち（pool_timeout の既定 10 秒）に揃える
export const TRANSACTION_OPTIONS = { maxWait: 10_000 } as const;

type Pragmas = { journalMode: string; busyTimeoutMs: number; foreignKeys: boolean };

// WAL は DB ファイルに保存される設定なので、起動時に1回設定すれば以後の接続にも効く。
// busy_timeout と foreign_keys は Prisma が接続ごとに設定する（busy_timeout は接続文字列の socket_timeout、既定 5 秒）。
// どれかが効いていなければ、ロック待ちや外部キーの検査が黙って失われるので、起動を止める
export async function configureSqlite(prisma: PrismaClient): Promise<Pragmas> {
  await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  const pragmas = await readPragmas(prisma);
  if (pragmas.journalMode !== "wal" || pragmas.busyTimeoutMs <= 0 || !pragmas.foreignKeys) {
    throw new Error(`SQLite の設定が想定と違う: ${JSON.stringify(pragmas)}`);
  }
  return pragmas;
}

export async function readPragmas(prisma: PrismaClient): Promise<Pragmas> {
  const [journal] = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode");
  const [busy] = await prisma.$queryRawUnsafe<{ timeout: bigint | number }[]>("PRAGMA busy_timeout");
  const [foreignKeys] = await prisma.$queryRawUnsafe<{ foreign_keys: bigint | number }[]>("PRAGMA foreign_keys");
  return {
    journalMode: journal.journal_mode,
    busyTimeoutMs: Number(busy.timeout),
    foreignKeys: Number(foreignKeys.foreign_keys) === 1,
  };
}
