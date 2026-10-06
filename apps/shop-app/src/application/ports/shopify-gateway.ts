// Shopify とのやり取りのポート（ADR 3）。アダプタは src/adapters/shopify/、統合テスト用のフェイクは src/adapters/shopify-fake/ にある。

// invoice を作れる注文かどうかの判断（ADR 4）に使う事実だけを持つ。判断そのものは application で行う
export type ShopifyOrder = {
  shopifyOrderId: string;
  // 注文に使われた支払い方法の名前。手動決済方法「Bitcoin で支払う」の注文かを確かめる
  paymentGatewayNames: string[];
  // Admin API の displayFinancialStatus（PENDING・PAID など）
  financialStatus: string;
  cancelled: boolean;
  // 請求額。未払いの残高（totalOutstandingSet）をショップの通貨で持つ。10進数の文字列（例: "1000.0"）
  outstanding: { amount: string; currencyCode: string };
};

export interface ShopifyGateway {
  // 注文がなければ null
  getOrder(shopifyOrderId: string): Promise<ShopifyOrder | null>;
}
