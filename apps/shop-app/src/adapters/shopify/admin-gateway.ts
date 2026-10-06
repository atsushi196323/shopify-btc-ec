// ShopifyGateway を Admin GraphQL API で実装する。
// クエリは、保存した Admin API のスキーマ（graphql/admin-2026-07.graphql）に対してテストで検証する（ADR 10）。
// テンプレートの codegen は依存の不具合で動かないので使わない（ADR 10）。
import type { ShopifyGateway, ShopifyOrder } from "../../application/ports/shopify-gateway";

// テンプレートの admin.graphql と同じ形。ショップごとの認証はこの関数を作る側（ルート）が済ませる
export type AdminGraphql = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

// 名前・住所・メール・電話は取らない（保護された顧客データの Level 1 に留める）
export const ORDER_FOR_INVOICE = `#graphql
  query OrderForInvoice($id: ID!) {
    order(id: $id) {
      id
      paymentGatewayNames
      displayFinancialStatus
      cancelledAt
      totalOutstandingSet {
        shopMoney {
          amount
          currencyCode
        }
      }
    }
  }
`;

// ORDER_FOR_INVOICE の結果の型。スキーマの null 許容に合わせて手で書く（テストでスキーマと照合する）
export type OrderForInvoiceQuery = {
  order: {
    id: string;
    paymentGatewayNames: string[];
    displayFinancialStatus: string | null;
    cancelledAt: string | null;
    totalOutstandingSet: { shopMoney: { amount: string; currencyCode: string } };
  } | null;
};

type GraphqlResponse<T> = { data?: T; errors?: unknown };

export class AdminShopifyGateway implements ShopifyGateway {
  constructor(private readonly graphql: AdminGraphql) {}

  async getOrder(shopifyOrderId: string): Promise<ShopifyOrder | null> {
    const response = await this.graphql(ORDER_FOR_INVOICE, { variables: { id: shopifyOrderId } });
    const body = (await response.json()) as GraphqlResponse<OrderForInvoiceQuery>;
    if (body.errors || !body.data) {
      throw new Error(`Shopify の注文 ${shopifyOrderId} を取得できない: ${JSON.stringify(body.errors)}`);
    }
    const order = body.data.order;
    if (!order) return null;
    return {
      shopifyOrderId: order.id,
      paymentGatewayNames: order.paymentGatewayNames,
      financialStatus: order.displayFinancialStatus ?? "UNKNOWN",
      cancelled: order.cancelledAt != null,
      outstanding: {
        amount: order.totalOutstandingSet.shopMoney.amount,
        currencyCode: order.totalOutstandingSet.shopMoney.currencyCode,
      },
    };
  }
}
