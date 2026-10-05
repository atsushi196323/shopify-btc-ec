import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GreenfieldConfig } from "../../src/adapters/btcpay/greenfield-client";

const regtestDir = join(__dirname, "..", "..", "..", "..", "infra", "regtest");

// infra/regtest/bootstrap.sh が書き出した値を読む。環境変数があればそちらを優先する（CI 用）
export function btcpayConfig(): GreenfieldConfig {
  const env: Record<string, string | undefined> = { ...readBootstrapEnv(), ...process.env };
  const baseUrl = env.BTCPAY_URL;
  const apiKey = env.BTCPAY_API_KEY;
  const storeId = env.BTCPAY_STORE_ID;
  if (!baseUrl || !apiKey || !storeId) {
    throw new Error("BTCPay の設定がない。infra/regtest/bootstrap.sh を実行する（infra/regtest/README.md）");
  }
  return { baseUrl, apiKey, storeId };
}

function readBootstrapEnv(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(join(regtestDir, ".bootstrap.env"), "utf8");
  } catch {
    return {};
  }
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1], match[2]]),
  );
}

// compose の bitcoind で bitcoin-cli を実行する。認証情報は docker-compose.yml の regtest 専用の値
export function bitcoinCli(...args: string[]): string {
  return execFileSync(
    "docker",
    [
      "compose",
      "-f",
      join(regtestDir, "docker-compose.yml"),
      "exec",
      "-T",
      "bitcoind",
      "bitcoin-cli",
      "-regtest",
      "-rpcuser=ceiwHEbqWI83",
      "-rpcpassword=DwubwWsoo3",
      "-rpcport=43782",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();
}

// テストの支払いには、bitcoind のイメージが初回起動時に作る default ウォレットを使う（ADR 10）
export function pay(address: string, amountBtc: string): string {
  return bitcoinCli("-rpcwallet=default", "sendtoaddress", address, amountBtc);
}

export function mineBlocks(count = 1): void {
  bitcoinCli("-rpcwallet=default", "-generate", String(count));
}
