import { describe, expect, it } from "vitest";
import { shopifyOrderIdFromExtension } from "../../../src/adapters/shopify/extension-request";

describe("shopifyOrderIdFromExtension", () => {
  it("Order の GID はそのまま返す", () => {
    expect(shopifyOrderIdFromExtension({ shopifyOrderId: "gid://shopify/Order/123" })).toBe("gid://shopify/Order/123");
  });

  it("OrderIdentity の GID は、同じ数字の Order の GID にそろえる", () => {
    expect(shopifyOrderIdFromExtension({ shopifyOrderId: "gid://shopify/OrderIdentity/123" })).toBe(
      "gid://shopify/Order/123",
    );
  });

  it.each([
    ["shopifyOrderId がない", {}],
    ["注文でない GID", { shopifyOrderId: "gid://shopify/Customer/1" }],
    ["数字でない", { shopifyOrderId: "gid://shopify/Order/abc" }],
    ["後ろに余計な文字がある", { shopifyOrderId: "gid://shopify/Order/1?x=1" }],
    ["文字列でない", { shopifyOrderId: 1 }],
    ["ボディが null", null],
  ])("%s なら null を返す", (_, body) => {
    expect(shopifyOrderIdFromExtension(body)).toBeNull();
  });
});
