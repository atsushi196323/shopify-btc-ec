import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const appRoot = join(__dirname, "..", "..");
const migrationsDir = join(appRoot, "prisma", "migrations");
const prismaBin = join(appRoot, "node_modules", ".bin", "prisma");

// 一時ディレクトリに SQLite を作り、prisma/migrations の SQL を順に流す。
// 開発用の dev.sqlite には触れず、本番と同じマイグレーションでテストする。
export function createTestDb(): { prisma: PrismaClient; cleanup: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), "shop-app-test-"));
  const url = `file:${join(dir, "test.sqlite")}`;

  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of migrations) {
    execFileSync(prismaBin, ["db", "execute", "--url", url, "--file", join(migrationsDir, name, "migration.sql")], {
      stdio: "pipe",
    });
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  return {
    prisma,
    cleanup: async () => {
      await prisma.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
