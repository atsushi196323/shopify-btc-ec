// コンポジションルートのうち、Shopify の認証と DB の接続に依存しない組み立て（ADR 3・10）。
// 本番（app/invoice.server.ts）と統合テスト（tests/helpers/regtest-app.ts）の両方がここを呼び、
// テストは BTCPay のデコレータやフェイクの Shopify を引数で差し込む。本番の組み立てとテストの組み立てを食い違わせない
import type { PrismaClient } from "@prisma/client";
import { PrismaInboxRepository } from "../src/adapters/db/prisma-inbox-repository";
import { PrismaPaymentRepository } from "../src/adapters/db/prisma-payment-repository";
import { normalizeShopDomain } from "../src/adapters/shopify/shop-domain";
import type { InvoiceDeps } from "../src/application/create-invoice";
import type { BtcpayGateway } from "../src/application/ports/btcpay-gateway";
import type { ShopifyGateway, ShopifyGatewayForShop } from "../src/application/ports/shopify-gateway";
import type { HandleEventDeps } from "../src/application/process-btcpay-event";

// invoice の作成・再発行・拡張 API の依存。shopify は shop で認証済みのもの。
// shop は Payment.shop に保存し、拡張から届いた注文のショップと比べるので、表記をそろえる
export function composeInvoiceDeps(
  prisma: PrismaClient,
  shop: string,
  btcpay: BtcpayGateway,
  shopify: ShopifyGateway,
): InvoiceDeps {
  return { shop: normalizeShopDomain(shop), payments: new PrismaPaymentRepository(prisma), btcpay, shopify };
}

// BTCPay の Webhook のワーカーとスイープの依存
export function composeBtcpayEventDeps(
  prisma: PrismaClient,
  btcpay: BtcpayGateway,
  shopifyFor: ShopifyGatewayForShop,
): HandleEventDeps {
  return {
    payments: new PrismaPaymentRepository(prisma),
    inbox: new PrismaInboxRepository(prisma),
    btcpay,
    shopifyFor,
  };
}
