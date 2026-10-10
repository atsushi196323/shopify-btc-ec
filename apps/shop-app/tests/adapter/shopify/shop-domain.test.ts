import { describe, expect, it } from "vitest";
import { normalizeShopDomain } from "../../../src/adapters/shopify/shop-domain";

describe("normalizeShopDomain", () => {
  it.each([
    ["bitcoin-ec.myshopify.com", "bitcoin-ec.myshopify.com"],
    ["Bitcoin-EC.myshopify.com", "bitcoin-ec.myshopify.com"],
    ["https://bitcoin-ec.myshopify.com", "bitcoin-ec.myshopify.com"],
    ["bitcoin-ec.myshopify.com/", "bitcoin-ec.myshopify.com"],
    [" https://bitcoin-ec.myshopify.com/ ", "bitcoin-ec.myshopify.com"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeShopDomain(input)).toBe(expected);
  });
});
