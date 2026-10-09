// invoice の作成（src/application/create-invoice.ts）と BTCPay の Webhook のワーカー（process-btcpay-event.ts）の依存を組み立てる。ルートはここから受け取るだけにする（ADR 3）
import { loadGreenfieldConfig } from "../src/adapters/btcpay/config";
import { GreenfieldClient } from "../src/adapters/btcpay/greenfield-client";
import { PrismaInboxRepository } from "../src/adapters/db/prisma-inbox-repository";
import { PrismaPaymentRepository } from "../src/adapters/db/prisma-payment-repository";
import { AdminShopifyGateway, type AdminGraphql } from "../src/adapters/shopify/admin-gateway";
import type { InvoiceDeps } from "../src/application/create-invoice";
import type { ProcessEventDeps } from "../src/application/process-btcpay-event";
import prisma from "./db.server";

// admin はショップごとに認証済みのクライアント（authenticate.webhook などが返す）
export function invoiceDeps(admin: { graphql: AdminGraphql }): InvoiceDeps {
  return {
    payments: new PrismaPaymentRepository(prisma),
    // 設定は呼ぶたびに読む。BTCPay の設定がなくても管理画面などほかのルートは動き、
    // `down -v` と bootstrap.sh で API キーやストアが変わっても、アプリを再起動せずに追いつける
    btcpay: new GreenfieldClient(loadGreenfieldConfig()),
    shopify: new AdminShopifyGateway(admin.graphql),
  };
}

// BTCPay の Webhook のワーカー。Shopify は呼ばないので、ショップの認証は要らない
export function btcpayEventDeps(): ProcessEventDeps {
  return {
    payments: new PrismaPaymentRepository(prisma),
    inbox: new PrismaInboxRepository(prisma),
    btcpay: new GreenfieldClient(loadGreenfieldConfig()),
  };
}
