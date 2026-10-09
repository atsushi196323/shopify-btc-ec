import { createServer, type Server } from "node:http";
import type { ProcessEventDeps, ProcessEventResult } from "../../src/application/process-btcpay-event";
import { receiveBtcpayWebhook } from "../../src/adapters/btcpay/webhook-handler";

// 統合テストの中で、BTCPay の Webhook の送信先（host.docker.internal:3000/webhooks/btcpay）を受ける（ADR 10）。
// 受信の処理はルートと同じ receiveBtcpayWebhook を使う。開発中のアプリが port 3000 を使っていると起動できない
export type WebhookServer = {
  // ワーカーの処理の結果。届いた順に入る
  results: (ProcessEventResult | null)[];
  // 401 で拒んだ配信の数
  rejected: number;
  close: () => Promise<void>;
};

export async function startWebhookServer(deps: ProcessEventDeps, secret: string, port = 3000): Promise<WebhookServer> {
  const state: WebhookServer = { results: [], rejected: 0, close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const request = new Request(`http://localhost:${port}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: Buffer.concat(chunks),
      });
      const { response, processed } = await receiveBtcpayWebhook(request, deps, secret);
      if (response.status === 401) state.rejected++;
      res.writeHead(response.status).end();
      state.results.push(await processed);
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, resolve));
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}
