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
      presentmentCurrencyCode
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
    presentmentCurrencyCode: string;
    totalOutstandingSet: { shopMoney: { amount: string; currencyCode: string } };
  } | null;
};

// 支払い済みにする（design.md 4章「Shopify への反映」）。支払い済みかの確認は呼び出し側が getOrder で行う
export const ORDER_MARK_AS_PAID = `#graphql
  mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order {
        id
        displayFinancialStatus
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export type OrderMarkAsPaidMutation = {
  orderMarkAsPaid: {
    order: { id: string; displayFinancialStatus: string | null } | null;
    userErrors: UserErrors;
  } | null;
};

// 未対応のフラグから導出したタグを付ける。付いているタグに対しては何もしない
export const TAGS_ADD = `#graphql
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export type TagsAddMutation = {
  tagsAdd: { node: { id: string } | null; userErrors: UserErrors } | null;
};

type UserErrors = { field: string[] | null; message: string }[];

type GraphqlResponse<T> = { data?: T; errors?: unknown };

export class AdminShopifyGateway implements ShopifyGateway {
  constructor(private readonly graphql: AdminGraphql) {}

  async getOrder(shopifyOrderId: string): Promise<ShopifyOrder | null> {
    const { order } = await this.run<OrderForInvoiceQuery>(
      `Shopify の注文 ${shopifyOrderId} を取得できない`,
      ORDER_FOR_INVOICE,
      { id: shopifyOrderId },
    );
    if (!order) return null;
    return {
      shopifyOrderId: order.id,
      paymentGatewayNames: order.paymentGatewayNames,
      financialStatus: order.displayFinancialStatus ?? "UNKNOWN",
      cancelled: order.cancelledAt != null,
      presentmentCurrencyCode: order.presentmentCurrencyCode,
      outstanding: {
        amount: order.totalOutstandingSet.shopMoney.amount,
        currencyCode: order.totalOutstandingSet.shopMoney.currencyCode,
      },
    };
  }

  async markOrderAsPaid(shopifyOrderId: string): Promise<void> {
    const context = `注文 ${shopifyOrderId} を支払い済みにできない`;
    const data = await this.run<OrderMarkAsPaidMutation>(context, ORDER_MARK_AS_PAID, { input: { id: shopifyOrderId } });
    assertNoUserErrors(context, data.orderMarkAsPaid);
  }

  async addOrderTags(shopifyOrderId: string, tags: string[]): Promise<void> {
    const context = `注文 ${shopifyOrderId} にタグを付けられない`;
    const data = await this.run<TagsAddMutation>(context, TAGS_ADD, { id: shopifyOrderId, tags });
    assertNoUserErrors(context, data.tagsAdd);
  }

  // GraphQL のエラー（権限・構文など）は、context を添えて例外にする
  private async run<T>(context: string, document: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.graphql(document, { variables });
    const body = (await response.json()) as GraphqlResponse<T>;
    if (body.errors || !body.data) throw new Error(`${context}: ${JSON.stringify(body.errors)}`);
    return body.data;
  }
}

// mutation の入力や注文の状態による失敗は、errors ではなく userErrors で返る。
// payload が null のときも、更新できたとはみなさない（成功として DONE にすると、二度と反映されない）
function assertNoUserErrors(context: string, payload: { userErrors: UserErrors } | null): void {
  if (!payload) throw new Error(`${context}: 結果が null`);
  if (payload.userErrors.length > 0) {
    throw new Error(`${context}: ${payload.userErrors.map((error) => error.message).join(" / ")}`);
  }
}
