// 統合テスト用の ShopifyGateway（ADR 10）。注文をメモリに持つ。
// 本物の API との食い違いは、アダプタのクエリを保存した Admin API のスキーマに対してテストで検証することで防ぐ
import type { ShopifyGateway, ShopifyOrder } from "../../application/ports/shopify-gateway";

export class FakeShopifyGateway implements ShopifyGateway {
  private readonly orders = new Map<string, ShopifyOrder>();

  addOrder(order: ShopifyOrder): void {
    this.orders.set(order.shopifyOrderId, structuredClone(order));
  }

  async getOrder(shopifyOrderId: string): Promise<ShopifyOrder | null> {
    const order = this.orders.get(shopifyOrderId);
    return order ? structuredClone(order) : null;
  }
}
