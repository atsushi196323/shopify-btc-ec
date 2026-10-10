// BTCPay の Webhook の受信（design.md 5.3 の 1・2、ADR 8）。ルート（app/routes/webhooks.btcpay.tsx）と統合テストの両方から使う。
// 署名を検証して inbox に保存し、すぐに 200 を返す。処理はワーカーに渡し、応答を待たせない
import { handleBtcpayEvent, type HandleEventDeps, type HandleEventResult } from "../../application/process-btcpay-event";
import { parseBtcpayWebhookEvent, verifyBtcpaySignature } from "./webhook";

// processed はワーカーの処理が終わったら解決する（統合テストが待つため。ルートは待たない）
export type WebhookReceipt = { response: Response; processed: Promise<HandleEventResult | null> };

export async function receiveBtcpayWebhook(request: Request, deps: HandleEventDeps, secret: string): Promise<WebhookReceipt> {
  // 署名は生のボディに対して計算されているので、パースする前に検証する
  const body = await request.text();
  if (!verifyBtcpaySignature(body, request.headers.get("BTCPay-Sig"), secret)) {
    console.warn("btcpay webhook: 署名が一致しない");
    return { response: new Response(null, { status: 401 }), processed: Promise.resolve(null) };
  }

  const event = parseBtcpayWebhookEvent(body);
  // invoice に関係しないイベントは保存しない。再送させないように 200 を返す
  if (!event) return { response: new Response(), processed: Promise.resolve(null) };

  const { inboxId, duplicate } = await deps.inbox.saveBtcpayEvent({
    eventId: event.deliveryId,
    type: event.type,
    invoiceId: event.invoiceId,
  });
  // 重複でも、行が PENDING のまま残っていれば処理する（PENDING でなければワーカーは何もしない）
  const processed = handleBtcpayEvent(deps, inboxId).then(
    (result) => {
      const sync = result.sync ? ` / Shopify: ${result.sync.outcome}` : "";
      console.log(`btcpay webhook ${event.type} ${event.invoiceId}${duplicate ? "（重複）" : ""}: ${result.event.outcome}${sync}`);
      return result;
    },
    (error: unknown) => {
      console.error(`btcpay webhook ${event.type} ${event.invoiceId}`, error);
      return null;
    },
  );
  return { response: new Response(), processed };
}
