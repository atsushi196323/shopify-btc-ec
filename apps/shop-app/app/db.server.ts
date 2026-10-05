import { PrismaClient } from "@prisma/client";
import { configureSqlite } from "../src/adapters/db/sqlite";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

// WAL・busy_timeout・foreign_keys が効いていなければ起動を止める（design.md 3章）。
// ビルドの対象（es2020）ではトップレベルの await が使えないので、失敗したらプロセスを終了する
configureSqlite(prisma).catch((error: unknown) => {
  console.error("SQLite の設定に失敗した", error);
  process.exit(1);
});

export default prisma;
