import { describe, expect, it } from "vitest";
import { toObservation } from "../../../src/adapters/btcpay/invoice-observation";

// ADR 6: BTCPay の status / additionalStatus からドメインの InvoiceObservation への変換
describe("toObservation", () => {
  it.each([
    ["New", "None", { status: "NEW", received: "NONE" }],
    ["New", "PaidPartial", { status: "NEW", received: "PARTIAL" }],
    ["Processing", "None", { status: "PROCESSING", received: "FULL" }],
    ["Processing", "PaidOver", { status: "PROCESSING", received: "OVER" }],
    ["Settled", "None", { status: "SETTLED", received: "FULL" }],
    ["Settled", "Marked", { status: "SETTLED", received: "FULL" }],
    ["Settled", "PaidOver", { status: "SETTLED", received: "OVER" }],
    ["Expired", "None", { status: "EXPIRED", received: "NONE" }],
    ["Expired", "PaidPartial", { status: "EXPIRED", received: "PARTIAL" }],
    ["Expired", "PaidLate", { status: "EXPIRED", received: "LATE" }],
    ["Invalid", "None", { status: "INVALID", received: "NONE" }],
    ["Invalid", "Marked", { status: "INVALID", received: "NONE" }],
    ["Invalid", "Invalid", { status: "INVALID", received: "NONE" }],
  ])("%s / %s", (status, additionalStatus, expected) => {
    expect(toObservation(status, additionalStatus)).toEqual(expected);
  });

  it.each([
    ["Paid", "None"],
    ["New", "Unknown"],
  ])("知らない値（%s / %s）は例外にする", (status, additionalStatus) => {
    expect(() => toObservation(status, additionalStatus)).toThrow("変換できない");
  });
});
