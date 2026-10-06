import { describe, expect, it } from "vitest";
import { checkOrderEligibility, type IneligibleReason } from "../../src/application/order-eligibility";
import type { ShopifyOrder } from "../../src/application/ports/shopify-gateway";

// invoice を作れる注文かどうかの判断（ADR 4）。依存なし
describe("checkOrderEligibility", () => {
  const order = (overrides: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
    shopifyOrderId: "gid://shopify/Order/1",
    paymentGatewayNames: ["Bitcoinで支払う"],
    financialStatus: "PENDING",
    cancelled: false,
    presentmentCurrencyCode: "JPY",
    outstanding: { amount: "1000.0", currencyCode: "JPY" },
    ...overrides,
  });

  it("Bitcoinで支払う、支払い待ちの JPY の注文には invoice を作れる", () => {
    expect(checkOrderEligibility(order())).toEqual({ eligible: true });
  });

  it("一部が別の方法で支払われた注文（PARTIALLY_PAID）にも、残高があれば作れる", () => {
    const partiallyPaid = order({
      paymentGatewayNames: ["gift_card", "Bitcoinで支払う"],
      financialStatus: "PARTIALLY_PAID",
      outstanding: { amount: "400.0", currencyCode: "JPY" },
    });

    expect(checkOrderEligibility(partiallyPaid)).toEqual({ eligible: true });
  });

  it.each<[string, Partial<ShopifyOrder>, IneligibleReason]>([
    ["Bitcoin 以外の支払い方法", { paymentGatewayNames: ["shopify_payments"] }, "NOT_BITCOIN_ORDER"],
    ["支払い方法がない", { paymentGatewayNames: [] }, "NOT_BITCOIN_ORDER"],
    ["キャンセル済み", { cancelled: true }, "CANCELLED"],
    ["支払い済み", { financialStatus: "PAID" }, "NOT_AWAITING_PAYMENT"],
    ["返金済み", { financialStatus: "REFUNDED" }, "NOT_AWAITING_PAYMENT"],
    ["取り消し済み", { financialStatus: "VOIDED" }, "NOT_AWAITING_PAYMENT"],
    ["客が JPY 以外の通貨で注文した（残高はショップの通貨の JPY）", { presentmentCurrencyCode: "USD" }, "UNSUPPORTED_CURRENCY"],
    ["ショップの通貨が JPY でない", { outstanding: { amount: "10.0", currencyCode: "USD" } }, "UNSUPPORTED_CURRENCY"],
    ["残高が0", { outstanding: { amount: "0.0", currencyCode: "JPY" } }, "NOTHING_OUTSTANDING"],
    ["残高が負", { outstanding: { amount: "-100.0", currencyCode: "JPY" } }, "NOTHING_OUTSTANDING"],
    ["残高が数値でない", { outstanding: { amount: "abc", currencyCode: "JPY" } }, "NOTHING_OUTSTANDING"],
  ])("%s の注文には作れない", (_, overrides, reason) => {
    expect(checkOrderEligibility(order(overrides))).toEqual({ eligible: false, reason });
  });
});
