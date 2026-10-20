// invoice の作成（src/application/create-invoice.ts）と BTCPay の Webhook のワーカー（process-btcpay-event.ts）の依存を組み立てる。ルートはここから受け取るだけにする（ADR 3）。
// 組み立て自体は app/composition.ts にあり、統合テストも同じものを呼ぶ。ここでは本番の DB・BTCPay・Shopify を渡す
import { loadGreenfieldConfig } from "../src/adapters/btcpay/config";
import { GreenfieldClient } from "../src/adapters/btcpay/greenfield-client";
import { AdminShopifyGateway, type AdminGraphql } from "../src/adapters/shopify/admin-gateway";
import type { InvoiceDeps } from "../src/application/create-invoice";
import type { HandleEventDeps } from "../src/application/process-btcpay-event";
import { composeBtcpayEventDeps, composeInvoiceDeps } from "./composition";
import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";

// admin は shop で認証済みのクライアント（authenticate.webhook などが返す）
export function invoiceDeps(shop: string, admin: { graphql: AdminGraphql }): InvoiceDeps {
  // 設定は呼ぶたびに読む。BTCPay の設定がなくても管理画面などほかのルートは動き、
  // `down -v` と bootstrap.sh で API キーやストアが変わっても、アプリを再起動せずに追いつける
  return composeInvoiceDeps(prisma, shop, new GreenfieldClient(loadGreenfieldConfig()), new AdminShopifyGateway(admin.graphql));
}

// BTCPay の Webhook のワーカー。Shopify からのリクエストではないので、Payment のショップのオフラインセッションで Shopify を呼ぶ
export function btcpayEventDeps(): HandleEventDeps {
  return composeBtcpayEventDeps(prisma, new GreenfieldClient(loadGreenfieldConfig()), async (shop) =>
    new AdminShopifyGateway((await unauthenticated.admin(shop)).admin.graphql),
  );
}
