import { describe, expect, it } from "vitest";
import { hasFlag, isReviewComplete, type ReviewFlag } from "../../../src/domain/review-flag";

const flag = (reason: ReviewFlag["reason"], attemptId: string, resolved: boolean): ReviewFlag => ({
  reason,
  attemptId,
  relatedAttemptId: null,
  resolved,
});

describe("ReviewFlag", () => {
  it("不変条件4: フラグがすべて対応済みなら、対応完了とみなす", () => {
    expect(isReviewComplete([flag("LATE_PAYMENT", "a1", true), flag("DOUBLE_PAYMENT", "a2", true)])).toBe(true);
  });

  it("不変条件4: 未対応のフラグが1つでもあれば、対応完了ではない", () => {
    expect(isReviewComplete([flag("LATE_PAYMENT", "a1", true), flag("DOUBLE_PAYMENT", "a2", false)])).toBe(false);
  });

  it("不変条件5: 対応済みでも (reason, attemptId) が同じなら同じ事象とみなす", () => {
    const flags = [flag("OVERPAID", "a1", true)];

    expect(hasFlag(flags, "OVERPAID", "a1")).toBe(true);
    expect(hasFlag(flags, "OVERPAID", "a2")).toBe(false);
    expect(hasFlag(flags, "UNDERPAID", "a1")).toBe(false);
  });
});
