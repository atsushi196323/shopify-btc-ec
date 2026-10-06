import type { ActionFunctionArgs } from "react-router";

// BTCPay の Webhook の送信先（infra/regtest/bootstrap.sh が登録する http://host.docker.internal:3000/webhooks/btcpay）。
// W2 では受け取って 200 を返すだけにする。BTCPay-Sig の検証・inbox への保存・ワーカーは W3 で実装する（design.md 5.3、ADR 8）。
// ここで捨てたイベントは失われない。ワーカーもペイロードは信用せず Greenfield から取り直すので、W3 のスイープの照合が追いつかせる
export const action = async ({ request }: ActionFunctionArgs) => {
  const body = await request.text();
  // 署名を検証していないので、ペイロードの値はログに出すだけで、どの処理にも使わない
  let event: { type?: unknown; invoiceId?: unknown; deliveryId?: unknown } = {};
  try {
    event = JSON.parse(body);
  } catch {
    // ログに出せないだけなので、200 を返す（BTCPay に再送させない）
  }
  console.log(
    `btcpay webhook (未処理): type=${String(event.type)} invoiceId=${String(event.invoiceId)} deliveryId=${String(event.deliveryId)} sig=${request.headers.has("BTCPay-Sig")}`,
  );
  return new Response();
};
