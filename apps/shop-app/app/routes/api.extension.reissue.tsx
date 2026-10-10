import type { ActionFunctionArgs } from "react-router";
import { shopifyOrderIdFromExtension } from "../../src/adapters/shopify/extension-request";
import { reissueForExtension } from "../../src/application/extension-invoice";
import { invoiceDeps } from "../invoice.server";
import { authenticate, unauthenticated } from "../shopify.server";

// 拡張の「invoice を再発行」ボタン（design.md 5.4）。Thank you ページの拡張が POST { shopifyOrderId } で呼ぶ。
// 認証と応答の形は拡張 API（api.extension.invoice.tsx）と同じ。処理は src/application/extension-invoice.ts に渡す
export const action = async ({ request }: ActionFunctionArgs) => {
  const { sessionToken, cors } = await authenticate.public.checkout(request);

  const shopifyOrderId = shopifyOrderIdFromExtension(await request.json().catch(() => null));
  if (!shopifyOrderId) return cors(Response.json({ error: "shopifyOrderId が不正" }, { status: 400 }));

  try {
    const { admin } = await unauthenticated.admin(sessionToken.dest);
    const view = await reissueForExtension(invoiceDeps(sessionToken.dest, admin), shopifyOrderId);
    return cors(Response.json(view));
  } catch (error) {
    // 拡張は失敗を表示し、もう一度押してもらう。新しい試行が CREATING のまま残ったら、スイープの孤児回復が追いつかせる
    console.error(`再発行 ${sessionToken.dest} ${shopifyOrderId}`, error);
    return cors(Response.json({ error: "一時的に処理できない" }, { status: 500 }));
  }
};
