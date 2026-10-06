import { describe, expect, it } from "vitest";
import { shopifyOrderIdFromWebhook } from "../../../src/adapters/shopify/order-webhook";

describe("shopifyOrderIdFromWebhook", () => {
  it("admin_graphql_api_id を注文の GID として返す", () => {
    const payload = { id: 820982911946154500, admin_graphql_api_id: "gid://shopify/Order/820982911946154508" };

    expect(shopifyOrderIdFromWebhook(payload)).toBe("gid://shopify/Order/820982911946154508");
  });

  it.each([
    ["GID がない", { id: 1 }],
    ["注文でない GID", { admin_graphql_api_id: "gid://shopify/Customer/1" }],
    ["文字列でない", { admin_graphql_api_id: 1 }],
    ["ペイロードが null", null],
  ])("%s なら例外にする", (_, payload) => {
    expect(() => shopifyOrderIdFromWebhook(payload)).toThrow("注文の GID がない");
  });
});
