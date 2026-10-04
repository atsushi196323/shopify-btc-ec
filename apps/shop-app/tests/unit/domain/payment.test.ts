import { describe, expect, it } from "vitest";
import {
  PAYMENT_STATUSES,
  applyObservation,
  canPaymentAdvance,
  reissue,
  type AttemptState,
  type InvoiceObservation,
  type PaymentState,
  type PaymentStatus,
} from "../../../src/domain/payment";
import type { InvoiceAttemptStatus } from "../../../src/domain/invoice-attempt";
import type { ReviewFlag } from "../../../src/domain/review-flag";

function attempt(id: string, status: InvoiceAttemptStatus, invalidatedByUs = false): AttemptState {
  return { id, status, invalidatedByUs };
}

function payment(
  status: PaymentStatus,
  attempts: AttemptState[],
  options: { currentAttemptId?: string; flags?: ReviewFlag[] } = {},
): PaymentState {
  return {
    status,
    currentAttemptId: options.currentAttemptId ?? attempts[attempts.length - 1].id,
    attempts,
    flags: options.flags ?? [],
  };
}

const observe = (status: InvoiceObservation["status"], received: InvoiceObservation["received"] = "NONE") => ({
  status,
  received,
});

// design.md 4章の遷移表のうち、イベントが起点のもの（途中を飛ばす遷移を含む）
const EVENT_FORWARD: ReadonlyArray<[PaymentStatus, PaymentStatus]> = [
  ["CREATING", "AWAITING_PAYMENT"],
  ["CREATING", "CONFIRMING"],
  ["CREATING", "PAID"],
  ["CREATING", "EXPIRED"],
  ["CREATING", "UNRESOLVED"],
  ["AWAITING_PAYMENT", "CONFIRMING"],
  ["AWAITING_PAYMENT", "PAID"],
  ["AWAITING_PAYMENT", "EXPIRED"],
  ["AWAITING_PAYMENT", "UNRESOLVED"],
  ["CONFIRMING", "PAID"],
  ["CONFIRMING", "UNRESOLVED"],
  ["EXPIRED", "UNRESOLVED"],
];

describe("Payment.status の遷移表", () => {
  const allPairs = PAYMENT_STATUSES.flatMap((from) => PAYMENT_STATUSES.map((to) => [from, to] as const));
  const isForward = (from: PaymentStatus, to: PaymentStatus) => EVENT_FORWARD.some(([f, t]) => f === from && t === to);

  it.each(EVENT_FORWARD)("%s → %s はイベントで進める", (from, to) => {
    expect(canPaymentAdvance(from, to)).toBe(true);
  });

  it.each(allPairs.filter(([from, to]) => !isForward(from, to)))("%s → %s はイベントでは進めない", (from, to) => {
    expect(canPaymentAdvance(from, to)).toBe(false);
  });
});

describe("現在の試行の観測", () => {
  it("CREATING → AWAITING_PAYMENT: 現在の試行が NEW", () => {
    const result = applyObservation(payment("CREATING", [attempt("a1", "CREATING")]), "a1", observe("NEW"));

    expect(result.state.status).toBe("AWAITING_PAYMENT");
    expect(result.state.attempts[0].status).toBe("NEW");
    expect(result).toMatchObject({ statusChanged: true, attemptStatusChanged: true, needsShopifySync: true });
  });

  it("AWAITING_PAYMENT → CONFIRMING → PAID: 現在の試行が PROCESSING → SETTLED", () => {
    const confirming = applyObservation(payment("AWAITING_PAYMENT", [attempt("a1", "NEW")]), "a1", observe("PROCESSING", "FULL"));
    const paid = applyObservation(confirming.state, "a1", observe("SETTLED", "FULL"));

    expect(confirming.state.status).toBe("CONFIRMING");
    expect(paid.state.status).toBe("PAID");
    expect(paid.newFlags).toEqual([]);
  });

  it("Webhook を取りこぼして途中を飛ばしても、前に進む（CREATING で SETTLED を観測 → PAID）", () => {
    const result = applyObservation(payment("CREATING", [attempt("a1", "CREATING")]), "a1", observe("SETTLED", "FULL"));

    expect(result.state.status).toBe("PAID");
  });

  it("AWAITING_PAYMENT → EXPIRED: 入金なしで期限切れ。フラグは付かない", () => {
    const result = applyObservation(payment("AWAITING_PAYMENT", [attempt("a1", "NEW")]), "a1", observe("EXPIRED"));

    expect(result.state.status).toBe("EXPIRED");
    expect(result.newFlags).toEqual([]);
    expect(result.attemptToInvalidate).toBeNull();
  });

  it("CONFIRMING → UNRESOLVED: 現在の試行が INVALID（INVALID_PAYMENT）", () => {
    const result = applyObservation(payment("CONFIRMING", [attempt("a1", "PROCESSING")]), "a1", observe("INVALID", "FULL"));

    expect(result.state.status).toBe("UNRESOLVED");
    expect(result.newFlags).toEqual([{ reason: "INVALID_PAYMENT", attemptId: "a1", relatedAttemptId: null }]);
  });

  it("一部入金のまま期限切れ → UNRESOLVED + UNDERPAID", () => {
    const result = applyObservation(payment("AWAITING_PAYMENT", [attempt("a1", "NEW")]), "a1", observe("EXPIRED", "PARTIAL"));

    expect(result.state.status).toBe("UNRESOLVED");
    expect(result.newFlags).toEqual([{ reason: "UNDERPAID", attemptId: "a1", relatedAttemptId: null }]);
  });

  it("EXPIRED → UNRESOLVED: 期限後の入金（LATE_PAYMENT）。自動では支払い済みにしない", () => {
    const result = applyObservation(payment("EXPIRED", [attempt("a1", "EXPIRED")]), "a1", observe("EXPIRED", "LATE"));

    expect(result.state.status).toBe("UNRESOLVED");
    expect(result.newFlags).toEqual([{ reason: "LATE_PAYMENT", attemptId: "a1", relatedAttemptId: null }]);
  });

  it("過払い → PAID + OVERPAID", () => {
    const result = applyObservation(payment("CONFIRMING", [attempt("a1", "PROCESSING")]), "a1", observe("SETTLED", "OVER"));

    expect(result.state.status).toBe("PAID");
    expect(result.newFlags).toEqual([{ reason: "OVERPAID", attemptId: "a1", relatedAttemptId: null }]);
  });
});

describe("古い試行に期限後の入金があったとき（design.md 4章の表）", () => {
  // a1 は期限切れで再発行済み、a2 が現在の試行
  const reissued = (status: PaymentStatus, a2: InvoiceAttemptStatus) =>
    payment(status, [attempt("a1", "EXPIRED"), attempt("a2", a2)]);

  it("新しい試行が未入金 → UNRESOLVED + LATE_PAYMENT、新しい invoice を無効化する", () => {
    const result = applyObservation(reissued("AWAITING_PAYMENT", "NEW"), "a1", observe("EXPIRED", "LATE"));

    expect(result.state.status).toBe("UNRESOLVED");
    expect(result.newFlags).toEqual([{ reason: "LATE_PAYMENT", attemptId: "a1", relatedAttemptId: null }]);
    expect(result.attemptToInvalidate).toBe("a2");
  });

  it("新しい試行が CONFIRMING → 無効化しない。DOUBLE_PAYMENT を付け、Settled になったら PAID", () => {
    const result = applyObservation(reissued("CONFIRMING", "PROCESSING"), "a1", observe("EXPIRED", "LATE"));
    const settled = applyObservation(result.state, "a2", observe("SETTLED", "FULL"));

    expect(result.state.status).toBe("CONFIRMING");
    expect(result.newFlags).toEqual([{ reason: "DOUBLE_PAYMENT", attemptId: "a1", relatedAttemptId: "a2" }]);
    expect(result.attemptToInvalidate).toBeNull();
    expect(settled.state.status).toBe("PAID");
  });

  it("新しい試行が PAID → DOUBLE_PAYMENT。status は PAID のまま", () => {
    const result = applyObservation(reissued("PAID", "SETTLED"), "a1", observe("EXPIRED", "LATE"));

    expect(result.state.status).toBe("PAID");
    expect(result.newFlags).toEqual([{ reason: "DOUBLE_PAYMENT", attemptId: "a1", relatedAttemptId: "a2" }]);
    expect(result.needsShopifySync).toBe(true);
  });

  it("無効化の直前に新しい試行へ入金されていた → 新しい試行に DOUBLE_PAYMENT（INVALID_PAYMENT ではない）", () => {
    const afterLate = payment("UNRESOLVED", [attempt("a1", "EXPIRED"), attempt("a2", "NEW", true)], {
      flags: [{ reason: "LATE_PAYMENT", attemptId: "a1", relatedAttemptId: null, resolved: false }],
    });

    const result = applyObservation(afterLate, "a2", observe("INVALID", "FULL"));

    expect(result.newFlags).toEqual([{ reason: "DOUBLE_PAYMENT", attemptId: "a2", relatedAttemptId: "a1" }]);
    expect(result.state.status).toBe("UNRESOLVED");
  });

  it("こちらで無効化した invoice が入金なしで INVALID になっても、フラグは増えず無効化も求めない", () => {
    const afterLate = payment("UNRESOLVED", [attempt("a1", "EXPIRED"), attempt("a2", "NEW", true)], {
      flags: [{ reason: "LATE_PAYMENT", attemptId: "a1", relatedAttemptId: null, resolved: false }],
    });

    const result = applyObservation(afterLate, "a2", observe("INVALID"));

    expect(result.newFlags).toEqual([]);
    expect(result.attemptToInvalidate).toBeNull();
    expect(result.needsShopifySync).toBe(false);
  });
});

describe("再発行（EXPIRED → CREATING）", () => {
  it("新しい試行を CREATING で作り、ポインタを付け替える。古い試行は EXPIRED のまま", () => {
    const result = reissue(payment("EXPIRED", [attempt("a1", "EXPIRED")]), "a2");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.status).toBe("CREATING");
    expect(result.state.currentAttemptId).toBe("a2");
    expect(result.state.attempts).toEqual([attempt("a1", "EXPIRED"), attempt("a2", "CREATING")]);
  });

  it.each(PAYMENT_STATUSES.filter((status) => status !== "EXPIRED"))("%s からは再発行できない", (status) => {
    const result = reissue(payment(status, [attempt("a1", "NEW")]), "a2");

    expect(result).toEqual({ ok: false, reason: "NOT_EXPIRED" });
  });

  it("既存の試行と同じ ID では再発行できない", () => {
    expect(() => reissue(payment("EXPIRED", [attempt("a1", "EXPIRED")]), "a1")).toThrow();
  });
});

describe("無効な遷移と冪等性", () => {
  it("古い状態を観測しても何もしない（PAID のあとに PROCESSING）", () => {
    const state = payment("PAID", [attempt("a1", "SETTLED")]);

    const result = applyObservation(state, "a1", observe("PROCESSING", "FULL"));

    expect(result.state).toEqual(state);
    expect(result).toMatchObject({ statusChanged: false, attemptStatusChanged: false, needsShopifySync: false });
  });

  it("同じ観測を2回当てても、2回目は何も変えない", () => {
    const first = applyObservation(payment("CONFIRMING", [attempt("a1", "PROCESSING")]), "a1", observe("SETTLED", "OVER"));
    const second = applyObservation(first.state, "a1", observe("SETTLED", "OVER"));

    expect(second.state).toEqual(first.state);
    expect(second.newFlags).toEqual([]);
    expect(second.needsShopifySync).toBe(false);
  });

  it("不変条件5: 対応済みのフラグと同じ事象を再検知しても、新しいフラグは作らない", () => {
    const state = payment("PAID", [attempt("a1", "SETTLED")], {
      flags: [{ reason: "OVERPAID", attemptId: "a1", relatedAttemptId: null, resolved: true }],
    });

    const result = applyObservation(state, "a1", observe("SETTLED", "OVER"));

    expect(result.newFlags).toEqual([]);
    expect(result.state.flags).toEqual(state.flags);
  });

  it("PAID の後の INVALID（reorg）は、MVP では何もしない（方針は ADR 9、テストは stretch）", () => {
    const state = payment("PAID", [attempt("a1", "SETTLED")]);

    const result = applyObservation(state, "a1", observe("INVALID", "FULL"));

    expect(result.state).toEqual(state);
  });

  it("UNRESOLVED は終端。現在の試行が後から SETTLED になっても PAID にはならない", () => {
    const state = payment("UNRESOLVED", [attempt("a1", "EXPIRED"), attempt("a2", "PROCESSING")], {
      flags: [
        { reason: "LATE_PAYMENT", attemptId: "a1", relatedAttemptId: null, resolved: false },
        { reason: "DOUBLE_PAYMENT", attemptId: "a2", relatedAttemptId: "a1", resolved: false },
      ],
    });

    const result = applyObservation(state, "a2", observe("SETTLED", "FULL"));

    expect(result.state.status).toBe("UNRESOLVED");
    expect(result.state.attempts[1].status).toBe("SETTLED");
  });

  it("別の Payment の試行は扱えない", () => {
    expect(() => applyObservation(payment("CREATING", [attempt("a1", "CREATING")]), "x", observe("NEW"))).toThrow();
  });
});
