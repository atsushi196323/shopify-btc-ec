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
  type AdminGraphql,
  type OrderForInvoiceQuery,
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
    const typeInfo = new TypeInfo(schema);
    const nullable: Record<string, boolean> = {};
    const path: string[] = [];
    visit(
      parse(ORDER_FOR_INVOICE),
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

    // OrderForInvoiceQuery の各項目で、`| null` を付けたものだけが true
    expect(nullable).toEqual({
      order: true,
      "order.id": false,
      "order.paymentGatewayNames": false,
      "order.displayFinancialStatus": true,
      "order.cancelledAt": true,
      "order.totalOutstandingSet": false,
      "order.totalOutstandingSet.shopMoney": false,
      "order.totalOutstandingSet.shopMoney.amount": false,
      "order.totalOutstandingSet.shopMoney.currencyCode": false,
    });
  });
});

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
        paymentGatewayNames: ["Bitcoin で支払う"],
        displayFinancialStatus: "PENDING",
        cancelledAt: null,
        totalOutstandingSet: { shopMoney: { amount: "1000.0", currencyCode: "JPY" } },
      },
    };
    const { gateway, calls } = gatewayReturning({ data });

    expect(await gateway.getOrder(orderId)).toEqual({
      shopifyOrderId: orderId,
      paymentGatewayNames: ["Bitcoin で支払う"],
      financialStatus: "PENDING",
      cancelled: false,
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
