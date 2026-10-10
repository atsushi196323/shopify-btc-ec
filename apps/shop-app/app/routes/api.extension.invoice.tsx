import type { ActionFunctionArgs } from "react-router";
import { shopifyOrderIdFromExtension } from "../../src/adapters/shopify/extension-request";
import { invoiceForExtension } from "../../src/application/extension-invoice";
import { invoiceDeps } from "../invoice.server";
import { authenticate, unauthenticated } from "../shopify.server";

// 拡張 API（design.md 5.2、ADR 4）。Thank you ページの拡張が POST { shopifyOrderId } で呼ぶ。
// 返すのは checkout link と表示用の状態だけ。処理は src/application/extension-invoice.ts に渡す
export const action = async ({ request }: ActionFunctionArgs) => {
  // セッショントークン（JWT）を検証する。プリフライト（OPTIONS）とボットの判定もここで応答される。
  // 認証失敗の 401 には CORS ヘッダが付かないので、拡張からは通信エラーに見える（ADR 1）
  const { sessionToken, cors } = await authenticate.public.checkout(request);

  const shopifyOrderId = shopifyOrderIdFromExtension(await request.json().catch(() => null));
  if (!shopifyOrderId) return cors(Response.json({ error: "shopifyOrderId が不正" }, { status: 400 }));

  try {
    // dest はトークンを発行したショップ。そのショップのオフラインセッションで Admin API を呼ぶ
    const { admin } = await unauthenticated.admin(sessionToken.dest);
    const view = await invoiceForExtension(invoiceDeps(sessionToken.dest, admin), shopifyOrderId);
    return cors(Response.json(view));
  } catch (error) {
    // BTCPay・Shopify の一時的な失敗。拡張は時間をおいて問い合わせ直す
    console.error(`拡張 API ${sessionToken.dest} ${shopifyOrderId}`, error);
    return cors(Response.json({ error: "一時的に処理できない" }, { status: 500 }));
  }
};
