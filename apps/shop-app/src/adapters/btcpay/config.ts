// BTCPay の接続設定を読む。アプリと統合テストで同じ読み方をする。
// 環境変数を優先し、なければ infra/regtest/bootstrap.sh が書き出した .bootstrap.env を読む（regtest 専用のポートフォリオなので、値の出どころを1つにする）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GreenfieldConfig } from "./greenfield-client";

// apps/shop-app から見た infra/regtest/.bootstrap.env
const BOOTSTRAP_ENV_PATH = join("..", "..", "infra", "regtest", ".bootstrap.env");

export function loadGreenfieldConfig(
  env: Record<string, string | undefined> = process.env,
  bootstrapEnvPath = BOOTSTRAP_ENV_PATH,
): GreenfieldConfig {
  const file = readEnvFile(bootstrapEnvPath);
  // 空文字の環境変数は「設定なし」として扱い、ファイルの値を使う
  const value = (key: string) => env[key]?.trim() || file[key];
  const baseUrl = value("BTCPAY_URL");
  const apiKey = value("BTCPAY_API_KEY");
  const storeId = value("BTCPAY_STORE_ID");
  if (!baseUrl || !apiKey || !storeId) {
    throw new Error("BTCPay の設定がない。infra/regtest/bootstrap.sh を実行する（infra/regtest/README.md）");
  }
  return { baseUrl, apiKey, storeId };
}

// KEY=VALUE の行だけを読む。ファイルがなければ空
function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim().match(/^([A-Z_]+)=(.*)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1], match[2]]),
  );
}
