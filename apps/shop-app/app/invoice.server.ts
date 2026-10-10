// invoice の作成（src/application/create-invoice.ts）と BTCPay の Webhook のワーカー（process-btcpay-event.ts）の依存を組み立てる。ルートはここから受け取るだけにする（ADR 3）
import { loadGreenfieldConfig } from "../src/adapters/btcpay/config";
import { GreenfieldClient } from "../src/adapters/btcpay/greenfield-client";
import { PrismaInboxRepository } from "../src/adapters/db/prisma-inbox-repository";
import { PrismaPaymentRepository } from "../src/adapters/db/prisma-payment-repository";
import { AdminShopifyGateway, type AdminGraphql } from "../src/adapters/shopify/admin-gateway";
import type { InvoiceDeps } from "../src/application/create-invoice";
import type { HandleEventDeps } from "../src/application/process-btcpay-event";
import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";

// admin は shop で認証済みのクライアント（authenticate.webhook などが返す）
export function invoiceDeps(shop: string, admin: { graphql: AdminGraphql }): InvoiceDeps {
  return {
    shop,
    payments: new PrismaPaymentRepository(prisma),
    // 設定は呼ぶたびに読む。BTCPay の設定がなくても管理画面などほかのルートは動き、
    // `down -v` と bootstrap.sh で API キーやストアが変わっても、アプリを再起動せずに追いつける
    btcpay: new GreenfieldClient(loadGreenfieldConfig()),
    shopify: new AdminShopifyGateway(admin.graphql),
  };
}

// BTCPay の Webhook のワーカー。Shopify からのリクエストではないので、Payment のショップのオフラインセッションで Shopify を呼ぶ
export function btcpayEventDeps(): HandleEventDeps {
  return {
    payments: new PrismaPaymentRepository(prisma),
    inbox: new PrismaInboxRepository(prisma),
    btcpay: new GreenfieldClient(loadGreenfieldConfig()),
    shopifyFor: async (shop) => new AdminShopifyGateway((await unauthenticated.admin(shop)).admin.graphql),
  };
}
