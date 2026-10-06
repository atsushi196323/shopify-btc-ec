import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadGreenfieldConfig } from "../../src/adapters/btcpay/config";
import type { GreenfieldConfig } from "../../src/adapters/btcpay/greenfield-client";

const regtestDir = join(__dirname, "..", "..", "..", "..", "infra", "regtest");

// infra/regtest/bootstrap.sh が書き出した値を読む。環境変数があればそちらを優先する（CI 用）
export function btcpayConfig(): GreenfieldConfig {
  return loadGreenfieldConfig(process.env, join(regtestDir, ".bootstrap.env"));
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
