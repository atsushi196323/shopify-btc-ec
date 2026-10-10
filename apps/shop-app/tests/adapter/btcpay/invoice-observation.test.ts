import { describe, expect, it } from "vitest";
import { compareDecimal, toObservation } from "../../../src/adapters/btcpay/invoice-observation";

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

  // ADR 9: 無効化した invoice への入金は additionalStatus に現れないので、payment-methods の totalPaid から決める
  it.each([
    ["0", "NONE"],
    ["0.00005", "PARTIAL"],
    ["0.0001", "FULL"],
    ["0.00010000", "FULL"],
    ["0.00010001", "OVER"],
  ])("Invalid / Marked で totalPaid が %s なら %s", (totalPaid, received) => {
    expect(toObservation("Invalid", "Marked", { totalPaid, amount: "0.0001" })).toEqual({ status: "INVALID", received });
  });

  it("BTCPay が Invalid にした invoice（Marked 以外）は、これまでどおり additionalStatus で判定する", () => {
    expect(toObservation("Invalid", "Invalid", { totalPaid: "0.0001", amount: "0.0001" })).toEqual({
      status: "INVALID",
      received: "NONE",
    });
  });

  it("Invalid 以外では totalPaid を使わない", () => {
    expect(toObservation("Expired", "None", { totalPaid: "0.0001", amount: "0.0001" })).toEqual({
      status: "EXPIRED",
      received: "NONE",
    });
  });
});

describe("compareDecimal", () => {
  it.each([
    ["1", "1.0", 0],
    ["0.1", "0.10000000", 0],
    ["10", "9.99999999", 1],
    ["0.00000001", "0.00000002", -1],
    ["007.5", "7.50", 0],
  ])("%s と %s", (a, b, expected) => {
    expect(compareDecimal(a, b)).toBe(expected);
  });

  it("10進数でない値は例外にする", () => {
    expect(() => compareDecimal("1e-8", "0")).toThrow("10進数");
  });
});
