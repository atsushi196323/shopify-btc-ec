import { randomUUID } from "node:crypto";
import type { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import type { ShopifyOrder } from "../../src/application/ports/shopify-gateway";

// テストの Payment と Shopify の呼び出しに使うショップ
export const TEST_SHOP = "test-shop.myshopify.com";

// 「Bitcoinで支払う」の支払い待ちの JPY の注文（¥1,000）。invoice を作れる注文の基準として、変えたい項目だけを上書きする
export function bitcoinOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    shopifyOrderId: `gid://shopify/Order/${randomUUID()}`,
    paymentGatewayNames: ["Bitcoinで支払う"],
    financialStatus: "PENDING",
    cancelled: false,
    presentmentCurrencyCode: "JPY",
    outstanding: { amount: "1000.0", currencyCode: "JPY" },
    ...overrides,
  };
}

// bitcoinOrder をフェイクの Shopify に足し、注文の GID を返す
export function addBitcoinOrder(shopify: FakeShopifyGateway, overrides: Partial<Omit<ShopifyOrder, "shopifyOrderId">> = {}): string {
  const order = bitcoinOrder(overrides);
  shopify.addOrder(order);
  return order.shopifyOrderId;
}
