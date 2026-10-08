// 拡張 API のリクエストのボディから、注文の GID だけを取り出す（design.md 5.2）。
// 値は信用せず、application で Admin API から注文を取り直す（ADR 4）
const ORDER_GID = /^gid:\/\/shopify\/Order(?:Identity)?\/(\d+)$/;

// 拡張の orderConfirmation.order.id は、型の説明では Order の GID。OrderIdentity の GID で届く可能性もあるので
// （実際の値は拡張の UI を作るときに確かめる）、数字の部分が同じ注文を指すとみなして Order の GID にそろえる
export function shopifyOrderIdFromExtension(body: unknown): string | null {
  const id = (body as { shopifyOrderId?: unknown } | null)?.shopifyOrderId;
  if (typeof id !== "string") return null;
  const match = ORDER_GID.exec(id);
  return match ? `gid://shopify/Order/${match[1]}` : null;
}
