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

// invoice のオンチェーンの支払い先と、残りの請求額（BTC）
export async function paymentMethod(config: GreenfieldConfig, invoiceId: string): Promise<{ destination: string; due: string }> {
  const response = await fetch(`${config.baseUrl}/api/v1/stores/${config.storeId}/invoices/${invoiceId}/payment-methods`, {
    headers: { Authorization: `token ${config.apiKey}` },
  });
  if (!response.ok) throw new Error(`payment-methods: ${response.status} ${await response.text()}`);
  const methods = (await response.json()) as { paymentMethodId: string; destination: string; due: string }[];
  const onchain = methods.find((method) => method.paymentMethodId === "BTC-CHAIN");
  if (!onchain) throw new Error(`invoice ${invoiceId} にオンチェーンの支払い方法がない`);
  return onchain;
}

// BTC 建ての額に倍率を掛ける（例: 半額・1.5倍）。テストの支払い額を作るだけなので、satoshi に丸める
export function scaleBtc(amountBtc: string, factor: number): string {
  return (Math.round(Number(amountBtc) * 1e8 * factor) / 1e8).toFixed(8);
}

// Webhook は非同期に届くので、条件が成り立つまで待つ。期限を過ぎたら諦め、呼び出し側の expect に判定を任せる
export async function waitFor(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition()) && Date.now() <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
