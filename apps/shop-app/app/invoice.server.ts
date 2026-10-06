// invoice の作成（src/application/create-invoice.ts）の依存を組み立てる。ルートはここから受け取るだけにする（ADR 3）
import { loadGreenfieldConfig } from "../src/adapters/btcpay/config";
import { GreenfieldClient } from "../src/adapters/btcpay/greenfield-client";
import { PrismaPaymentRepository } from "../src/adapters/db/prisma-payment-repository";
import { AdminShopifyGateway, type AdminGraphql } from "../src/adapters/shopify/admin-gateway";
import type { InvoiceDeps } from "../src/application/create-invoice";
import prisma from "./db.server";

let btcpay: GreenfieldClient | undefined;

// 設定は最初に使うときに読む。BTCPay の設定がなくても、管理画面などほかのルートは動くようにする
function btcpayClient(): GreenfieldClient {
  btcpay ??= new GreenfieldClient(loadGreenfieldConfig());
  return btcpay;
}

// admin はショップごとに認証済みのクライアント（authenticate.webhook などが返す）
export function invoiceDeps(admin: { graphql: AdminGraphql }): InvoiceDeps {
  return {
    payments: new PrismaPaymentRepository(prisma),
    btcpay: btcpayClient(),
    shopify: new AdminShopifyGateway(admin.graphql),
  };
}
