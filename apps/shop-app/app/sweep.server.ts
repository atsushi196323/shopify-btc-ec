// スイープ（src/application/sweep.ts）を、アプリのプロセスの中で定期的に回す（design.md 5.5）。
// ワーカーと同じプロセスで動かす（水平スケールは考慮しない。既知の制限）。前の回が終わってから次の回を予約するので、回は重ならない
import { runSweep, type SweepReport } from "../src/application/sweep";
import { btcpayEventDeps } from "./invoice.server";

const INTERVAL_MS = 30_000;

declare global {
  // 開発サーバーはモジュールを読み直すので、タイマーを二重に起動しないように、プロセスで1つだけ持つ。
  // 1回分の処理（sweepOnce）は読み込むたびに差し替え、タイマーが最新のコードを回すようにする
  // eslint-disable-next-line no-var
  var sweepStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var sweepOnce: (() => Promise<void>) | undefined;
}

// 依存は回ごとに組み立てる。BTCPay の設定を毎回読む（app/invoice.server.ts と同じ理由）
globalThis.sweepOnce = async () => log(await runSweep(btcpayEventDeps()));

// 本番（react-router-serve）はビルドを起動時に読み込むので、起動と同時に始まる。
// 開発サーバー（Vite）はサーバーのエントリを最初のリクエストで読み込むので、それまでは始まらない
export function startSweep(): void {
  if (globalThis.sweepStarted) return;
  globalThis.sweepStarted = true;
  schedule();
}

function schedule(): void {
  setTimeout(async () => {
    try {
      await globalThis.sweepOnce?.();
    } catch (error) {
      console.error("sweep: 失敗した", error);
    } finally {
      schedule();
    }
  }, INTERVAL_MS).unref();
}

// 何か変わった段だけ、結果を出す。照合で変わるものがなかった（NO_CHANGE）件は毎回出るので省く。失敗は内容も出す
function log(report: SweepReport): void {
  for (const [step, all] of Object.entries(report)) {
    const items = all.filter((item) => item.outcome !== "NO_CHANGE");
    if (items.length === 0) continue;
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.outcome, (counts.get(item.outcome) ?? 0) + 1);
    const summary = [...counts].map(([outcome, count]) => `${outcome}=${count}`).join(" ");
    console.log(`sweep ${step}: ${summary}`);
    for (const item of items) {
      if (item.error) console.error(`sweep ${step} ${item.id}: ${item.error}`);
    }
  }
}
