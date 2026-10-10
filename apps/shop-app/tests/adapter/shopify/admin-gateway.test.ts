import { readFileSync } from "node:fs";
import {
  TypeInfo,
  buildSchema,
  isNonNullType,
  parse,
  validate,
  visit,
  visitWithTypeInfo,
  type GraphQLSchema,
} from "graphql";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AdminShopifyGateway,
  ORDER_FOR_INVOICE,
  ORDER_MARK_AS_PAID,
  TAGS_ADD,
  type AdminGraphql,
  type OrderForInvoiceQuery,
  type OrderMarkAsPaidMutation,
  type TagsAddMutation,
} from "../../../src/adapters/shopify/admin-gateway";

// ADR 10: 本物の API との食い違いを、保存した Admin API のスキーマ（scripts/fetch-admin-schema.mjs で取得）で防ぐ
describe("ORDER_FOR_INVOICE とスキーマ（2026-07）", () => {
  let schema: GraphQLSchema;

  beforeAll(() => {
    schema = buildSchema(readFileSync(new URL("../../../graphql/admin-2026-07.graphql", import.meta.url), "utf8"));
  });

  it("スキーマに対して妥当なクエリである", () => {
    expect(validate(schema, parse(ORDER_FOR_INVOICE)).map((error) => error.message)).toEqual([]);
  });

  // OrderForInvoiceQuery は手で書いた型なので、null を許すかどうかがスキーマと一致することを確かめる
  it("結果の型の null 許容が、スキーマと一致する", () => {
    const nullable = nullability(schema, ORDER_FOR_INVOICE);

    // OrderForInvoiceQuery の各項目で、`| null` を付けたものだけが true
    expect(nullable).toEqual({
      order: true,
      "order.id": false,
      "order.paymentGatewayNames": false,
      "order.displayFinancialStatus": true,
      "order.cancelledAt": true,
      "order.presentmentCurrencyCode": false,
      "order.totalOutstandingSet": false,
      "order.totalOutstandingSet.shopMoney": false,
      "order.totalOutstandingSet.shopMoney.amount": false,
      "order.totalOutstandingSet.shopMoney.currencyCode": false,
    });
  });
});

describe("ORDER_MARK_AS_PAID・TAGS_ADD とスキーマ（2026-07）", () => {
  let schema: GraphQLSchema;

  beforeAll(() => {
    schema = buildSchema(readFileSync(new URL("../../../graphql/admin-2026-07.graphql", import.meta.url), "utf8"));
  });

  it("スキーマに対して妥当な mutation である", () => {
    expect(validate(schema, parse(ORDER_MARK_AS_PAID)).map((error) => error.message)).toEqual([]);
    expect(validate(schema, parse(TAGS_ADD)).map((error) => error.message)).toEqual([]);
  });

  // OrderMarkAsPaidMutation・TagsAddMutation の各項目で、`| null` を付けたものだけが true
  it("結果の型の null 許容が、スキーマと一致する", () => {
    expect(nullability(schema, ORDER_MARK_AS_PAID)).toEqual({
      orderMarkAsPaid: true,
      "orderMarkAsPaid.order": true,
      "orderMarkAsPaid.order.id": false,
      "orderMarkAsPaid.order.displayFinancialStatus": true,
      "orderMarkAsPaid.userErrors": false,
      "orderMarkAsPaid.userErrors.field": true,
      "orderMarkAsPaid.userErrors.message": false,
    });
    expect(nullability(schema, TAGS_ADD)).toEqual({
      tagsAdd: true,
      "tagsAdd.node": true,
      "tagsAdd.node.id": false,
      "tagsAdd.userErrors": false,
      "tagsAdd.userErrors.field": true,
      "tagsAdd.userErrors.message": false,
    });
  });
});

// 選択した各項目（ドットでつないだパス）が、スキーマで null を許すか
function nullability(schema: GraphQLSchema, document: string): Record<string, boolean> {
  const typeInfo = new TypeInfo(schema);
  const nullable: Record<string, boolean> = {};
  const path: string[] = [];
  visit(
    parse(document),
    visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node) {
          path.push(node.name.value);
          nullable[path.join(".")] = !isNonNullType(typeInfo.getType());
        },
        leave() {
          path.pop();
        },
      },
    }),
  );
  return nullable;
}

describe("AdminShopifyGateway.getOrder", () => {
  const orderId = "gid://shopify/Order/1001";

  function gatewayReturning(body: unknown) {
    const calls: { query: string; variables?: Record<string, unknown> }[] = [];
    const graphql: AdminGraphql = async (query, options) => {
      calls.push({ query, variables: options?.variables });
      return new Response(JSON.stringify(body));
    };
    return { gateway: new AdminShopifyGateway(graphql), calls };
  }

  it("注文を ShopifyOrder に変換する", async () => {
    const data: OrderForInvoiceQuery = {
      order: {
        id: orderId,
        paymentGatewayNames: ["Bitcoinで支払う"],
        displayFinancialStatus: "PENDING",
        cancelledAt: null,
        presentmentCurrencyCode: "JPY",
        totalOutstandingSet: { shopMoney: { amount: "1000.0", currencyCode: "JPY" } },
      },
    };
    const { gateway, calls } = gatewayReturning({ data });

    expect(await gateway.getOrder(orderId)).toEqual({
      shopifyOrderId: orderId,
      paymentGatewayNames: ["Bitcoinで支払う"],
      financialStatus: "PENDING",
      cancelled: false,
      presentmentCurrencyCode: "JPY",
      outstanding: { amount: "1000.0", currencyCode: "JPY" },
    });
    expect(calls).toEqual([{ query: ORDER_FOR_INVOICE, variables: { id: orderId } }]);
  });

  it("キャンセル済みの注文は cancelled になる", async () => {
    const { gateway } = gatewayReturning({
      data: {
        order: {
          id: orderId,
          paymentGatewayNames: [],
          displayFinancialStatus: null,
          cancelledAt: "2026-10-05T00:00:00Z",
          presentmentCurrencyCode: "JPY",
          totalOutstandingSet: { shopMoney: { amount: "0.0", currencyCode: "JPY" } },
        },
      },
    });

    expect(await gateway.getOrder(orderId)).toMatchObject({ cancelled: true, financialStatus: "UNKNOWN" });
  });

  it("注文がなければ null を返す", async () => {
    const { gateway } = gatewayReturning({ data: { order: null } });

    expect(await gateway.getOrder(orderId)).toBeNull();
  });

  it("GraphQL のエラーは例外にする", async () => {
    const { gateway } = gatewayReturning({ errors: [{ message: "Access denied for order field." }] });

    await expect(gateway.getOrder(orderId)).rejects.toThrow("Access denied");
  });
});

describe("AdminShopifyGateway の更新", () => {
  const orderId = "gid://shopify/Order/1001";

  function gatewayReturning(body: unknown) {
    const calls: { query: string; variables?: Record<string, unknown> }[] = [];
    const graphql: AdminGraphql = async (query, options) => {
      calls.push({ query, variables: options?.variables });
      return new Response(JSON.stringify(body));
    };
    return { gateway: new AdminShopifyGateway(graphql), calls };
  }

  it("markOrderAsPaid は注文の GID を input.id で渡す", async () => {
    const data: OrderMarkAsPaidMutation = {
      orderMarkAsPaid: { order: { id: orderId, displayFinancialStatus: "PAID" }, userErrors: [] },
    };
    const { gateway, calls } = gatewayReturning({ data });

    await gateway.markOrderAsPaid(orderId);

    expect(calls).toEqual([{ query: ORDER_MARK_AS_PAID, variables: { input: { id: orderId } } }]);
  });

  it("addOrderTags は注文の GID とタグを渡す", async () => {
    const data: TagsAddMutation = { tagsAdd: { node: { id: orderId }, userErrors: [] } };
    const { gateway, calls } = gatewayReturning({ data });

    await gateway.addOrderTags(orderId, ["btc-review-overpaid"]);

    expect(calls).toEqual([{ query: TAGS_ADD, variables: { id: orderId, tags: ["btc-review-overpaid"] } }]);
  });

  it("userErrors は例外にする", async () => {
    const { gateway } = gatewayReturning({
      data: { orderMarkAsPaid: { order: null, userErrors: [{ field: ["id"], message: "Order cannot be marked as paid." }] } },
    });

    await expect(gateway.markOrderAsPaid(orderId)).rejects.toThrow("Order cannot be marked as paid.");
  });

  it("payload が null なら、更新できたとはみなさず例外にする", async () => {
    const { gateway } = gatewayReturning({ data: { orderMarkAsPaid: null } });

    await expect(gateway.markOrderAsPaid(orderId)).rejects.toThrow("結果が null");
  });

  it("GraphQL のエラーは例外にする", async () => {
    const { gateway } = gatewayReturning({ errors: [{ message: "Access denied for tagsAdd field." }] });

    await expect(gateway.addOrderTags(orderId, ["btc-review-overpaid"])).rejects.toThrow("Access denied");
  });
});
