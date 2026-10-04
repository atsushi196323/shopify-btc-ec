import { describe, expect, it } from "vitest";
import {
  INVOICE_ATTEMPT_STATUSES,
  advanceAttempt,
  canAdvance,
  isTerminalAttempt,
  type InvoiceAttemptStatus,
} from "../../../src/domain/invoice-attempt";

// design.md 4章の図から、前に進む組をすべて書き出したもの（途中を飛ばす遷移を含む）
const FORWARD: ReadonlyArray<[InvoiceAttemptStatus, InvoiceAttemptStatus]> = [
  ["CREATING", "NEW"],
  ["CREATING", "PROCESSING"],
  ["CREATING", "SETTLED"],
  ["CREATING", "EXPIRED"],
  ["CREATING", "INVALID"],
  ["NEW", "PROCESSING"],
  ["NEW", "SETTLED"],
  ["NEW", "EXPIRED"],
  ["NEW", "INVALID"],
  ["PROCESSING", "SETTLED"],
  ["PROCESSING", "INVALID"],
];

const ALL_PAIRS = INVOICE_ATTEMPT_STATUSES.flatMap((from) => INVOICE_ATTEMPT_STATUSES.map((to) => [from, to] as const));
const isForward = (from: InvoiceAttemptStatus, to: InvoiceAttemptStatus) =>
  FORWARD.some(([f, t]) => f === from && t === to);

describe("InvoiceAttempt.status の状態機械", () => {
  it.each(FORWARD)("%s → %s は前に進む", (from, to) => {
    expect(canAdvance(from, to)).toBe(true);
    expect(advanceAttempt(from, to)).toBe(to);
  });

  it.each(ALL_PAIRS.filter(([from, to]) => !isForward(from, to)))(
    "%s → %s は無効な遷移で、何もしない（no-op）",
    (from, to) => {
      expect(canAdvance(from, to)).toBe(false);
      expect(advanceAttempt(from, to)).toBe(from);
    },
  );

  it("終端は SETTLED・EXPIRED・INVALID だけ", () => {
    const terminals = INVOICE_ATTEMPT_STATUSES.filter(isTerminalAttempt);
    expect(terminals).toEqual(["SETTLED", "EXPIRED", "INVALID"]);
  });
});
