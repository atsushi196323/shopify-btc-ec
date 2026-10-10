import type { ActionFunctionArgs } from "react-router";
import { shopifyOrderIdFromWebhook } from "../../src/adapters/shopify/order-webhook";
import { createInvoiceForOrder } from "../../src/application/create-invoice";
import { invoiceDeps } from "../invoice.server";
import { authenticate } from "../shopify.server";

// orders/create（design.md 5.1、ADR 5）。MVP では inbox を通さず、リクエストの中で invoice を作る。
// 例外は 500 にして Shopify の再送に任せる。再送は shopifyOrderId の UNIQUE に負けて既存の行を返すので、重複しない。
// BTCPay の呼び出しの後で落ちて CREATING のまま残った試行は、スイープの孤児回復が追いつかせる
export const action = async ({ request }: ActionFunctionArgs) => {
  // X-Shopify-Hmac-Sha256 の検証はテンプレートが行う
  const { admin, payload, shop } = await authenticate.webhook(request);
  // アンインストール後に届いた Webhook にはセッションがなく、Admin API を呼べない
  if (!admin) return new Response();

  const shopifyOrderId = shopifyOrderIdFromWebhook(payload);
  const result = await createInvoiceForOrder(invoiceDeps(shop, admin), shopifyOrderId);
  console.log(
    `orders/create ${shop} ${shopifyOrderId}: ${result.outcome}${result.outcome === "NOT_ELIGIBLE" ? ` (${result.reason})` : ""}`,
  );
  return new Response();
};
