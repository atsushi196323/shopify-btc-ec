// Admin GraphQL API のスキーマを取得し、graphql/admin-<版>.graphql に保存する。
// アダプタのクエリは、このスキーマに対してテストで検証する（tests/adapter/shopify/）。
// 使い方: pnpm schema:admin（版を上げるときは API_VERSION を app/shopify.server.ts・shopify.app.toml・拡張と同時に変える。ADR 3）
import { writeFileSync } from "node:fs";
import { buildClientSchema, getIntrospectionQuery, printSchema } from "graphql";

const API_VERSION = "2026-07";

const response = await fetch(`https://shopify.dev/admin-graphql-direct-proxy/${API_VERSION}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  // 検証に説明文は要らないので除く（ファイルが小さくなる）
  body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: false }) }),
});
const body = await response.json();
if (!body.data) throw new Error(`スキーマを取得できない: ${response.status} ${JSON.stringify(body).slice(0, 300)}`);

const path = new URL(`../graphql/admin-${API_VERSION}.graphql`, import.meta.url);
writeFileSync(path, `# ${API_VERSION} の Admin GraphQL API。scripts/fetch-admin-schema.mjs で生成する（手で編集しない）\n${printSchema(buildClientSchema(body.data))}\n`);
console.log(`保存した: ${path.pathname}`);
