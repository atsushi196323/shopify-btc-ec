// W1 の compose 検証専用の仮エンドポイント（design.md 8章 完了ライン 4）。
// BTCPay の Webhook を port 3000 で受け、BTCPay-Sig ヘッダと生のボディをログに出す。
// W2 以降はアプリ本体の /webhooks/btcpay に置き換えるので、アプリからは使わない。
//
// 起動: node infra/regtest/webhook-echo.mjs
// BTCPay 側の送信先: http://host.docker.internal:3000/webhooks/btcpay
import { createServer } from "node:http";

const PORT = 3000;

createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    console.log(`--- ${new Date().toISOString()} ${req.method} ${req.url}`);
    console.log(`BTCPay-Sig: ${req.headers["btcpay-sig"] ?? "(なし)"}`);
    console.log(rawBody);
    res.writeHead(200).end();
  });
}).listen(PORT, () => console.log(`listening on :${PORT}`));
