// orders/create Webhook のペイロードから、注文の GID だけを取り出す。
// ペイロードのほかの値（金額・支払い方法）は信用せず、Admin API で取り直す（ADR 4）
const ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;

export function shopifyOrderIdFromWebhook(payload: unknown): string {
  const id = (payload as { admin_graphql_api_id?: unknown } | null)?.admin_graphql_api_id;
  if (typeof id !== "string" || !ORDER_GID.test(id)) {
    throw new Error(`orders/create のペイロードに注文の GID がない: ${JSON.stringify(id)}`);
  }
  return id;
}
