// BTCPay の Webhook の受信（design.md 5.3 の 1・2、ADR 8）。署名を検証し、inbox に保存する項目だけを取り出す。
import { createHmac, timingSafeEqual } from "node:crypto";

// BTCPay-Sig は「sha256=<生のボディの HMAC-SHA256 の16進>」。鍵は Webhook を登録したときの secret（ADR 10 の W1 で確認）
export function verifyBtcpaySignature(rawBody: string, header: string | null, secret: string): boolean {
  const match = header?.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(match[1], "hex"));
}

// inbox に保存するイベント。ワーカーは invoice の状態を Greenfield から取り直すので（ADR 8 の決定2）、ペイロードからは invoice ID だけを使う
export type BtcpayWebhookEvent = {
  // 配信ごとの ID。手動で再送すると新しい ID になるので、重複の除去は最適化にすぎない（ADR 8）
  deliveryId: string;
  type: string;
  invoiceId: string;
};

// invoice に関係しないイベント（invoiceId がない）と、形の崩れたボディは null
export function parseBtcpayWebhookEvent(rawBody: string): BtcpayWebhookEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const { deliveryId, type, invoiceId } = event as Record<string, unknown>;
  if (typeof deliveryId !== "string" || typeof type !== "string" || typeof invoiceId !== "string") return null;
  if (!deliveryId || !invoiceId) return null;
  return { deliveryId, type, invoiceId };
}
