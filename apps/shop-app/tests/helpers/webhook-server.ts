import { createServer, type Server } from "node:http";
import type { HandleEventDeps, HandleEventResult } from "../../src/application/process-btcpay-event";
import { parseBtcpayWebhookEvent, type BtcpayWebhookEvent } from "../../src/adapters/btcpay/webhook";
import { receiveBtcpayWebhook } from "../../src/adapters/btcpay/webhook-handler";

// 統合テストの中で、BTCPay の Webhook の送信先（host.docker.internal:3000/webhooks/btcpay）を受ける（ADR 10）。
// 受信の処理はルートと同じ receiveBtcpayWebhook を使う。開発中のアプリが port 3000 を使っていると起動できない
export type WebhookServer = {
  // 署名を検証できた配信と、ワーカーの処理の結果。届いた順に入る（invoice に関係しない配信は event・result とも null）
  received: { event: BtcpayWebhookEvent | null; result: HandleEventResult | null }[];
  // 401 で拒んだ配信の数
  rejected: number;
  close: () => Promise<void>;
};

export async function startWebhookServer(deps: HandleEventDeps, secret: string, port = 3000): Promise<WebhookServer> {
  const state: WebhookServer = { received: [], rejected: 0, close: async () => {} };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const request = new Request(`http://localhost:${port}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body,
      });
      const { response, processed } = await receiveBtcpayWebhook(request, deps, secret);
      res.writeHead(response.status).end();
      if (response.status === 401) {
        state.rejected++;
        return;
      }
      state.received.push({ event: parseBtcpayWebhookEvent(body.toString("utf8")), result: await processed });
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, resolve));
  state.close = () => new Promise((resolve) => server.close(() => resolve()));
  return state;
}
