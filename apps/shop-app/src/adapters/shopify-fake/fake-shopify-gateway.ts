// 統合テスト用の ShopifyGateway（ADR 10）。注文をメモリに持つ。
// 本物の API との食い違いは、アダプタのクエリを保存した Admin API のスキーマに対してテストで検証することで防ぐ
import type { ShopifyGateway, ShopifyOrder } from "../../application/ports/shopify-gateway";

export class FakeShopifyGateway implements ShopifyGateway {
  private readonly orders = new Map<string, ShopifyOrder>();
  private readonly tags = new Map<string, Set<string>>();
  // markOrderAsPaid を呼んだ注文。呼んだ回数を確かめるために、同じ注文も重ねて記録する（シナリオ5）
  readonly markedAsPaid: string[] = [];

  addOrder(order: ShopifyOrder): void {
    this.orders.set(order.shopifyOrderId, structuredClone(order));
  }

  async getOrder(shopifyOrderId: string): Promise<ShopifyOrder | null> {
    const order = this.orders.get(shopifyOrderId);
    return order ? structuredClone(order) : null;
  }

  // 支払い済みの注文は displayFinancialStatus が PAID になる。支払い済みの注文に呼ぶのは呼び出し側の誤りとして失敗させる
  async markOrderAsPaid(shopifyOrderId: string): Promise<void> {
    const order = this.orders.get(shopifyOrderId);
    if (!order) throw new Error(`注文 ${shopifyOrderId} がない`);
    this.markedAsPaid.push(shopifyOrderId);
    if (order.financialStatus === "PAID") throw new Error(`注文 ${shopifyOrderId} はすでに支払い済み`);
    // キャンセル済み・返金済みなどの注文は、本物と同じく支払い済みにできない
    if (order.cancelled || !["PENDING", "PARTIALLY_PAID"].includes(order.financialStatus)) {
      throw new Error(`注文 ${shopifyOrderId} は支払い済みにできない（${order.financialStatus}）`);
    }
    order.financialStatus = "PAID";
  }

  async addOrderTags(shopifyOrderId: string, tags: string[]): Promise<void> {
    if (!this.orders.has(shopifyOrderId)) throw new Error(`注文 ${shopifyOrderId} がない`);
    const current = this.tags.get(shopifyOrderId) ?? new Set();
    for (const tag of tags) current.add(tag);
    this.tags.set(shopifyOrderId, current);
  }

  orderTags(shopifyOrderId: string): string[] {
    return [...(this.tags.get(shopifyOrderId) ?? [])].sort();
  }
}
