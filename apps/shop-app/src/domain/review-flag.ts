// ReviewFlag（design.md 4章、ADR 6）。お金に関する異常を、人が対応すべき事情として漏れなく記録する。

export const REVIEW_REASONS = ["UNDERPAID", "LATE_PAYMENT", "DOUBLE_PAYMENT", "INVALID_PAYMENT", "OVERPAID"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export type ReviewFlag = {
  reason: ReviewReason;
  attemptId: string;
  // DOUBLE_PAYMENT のときの相手の試行
  relatedAttemptId: string | null;
  resolved: boolean;
};

export type NewReviewFlag = Omit<ReviewFlag, "resolved">;

// 不変条件5: (reason, attemptId) が同じフラグは、対応済みでも同じ事象とみなす
export function hasFlag(flags: readonly ReviewFlag[], reason: ReviewReason, attemptId: string): boolean {
  return flags.some((flag) => flag.reason === reason && flag.attemptId === attemptId);
}

// 不変条件4: フラグがすべて対応済みなら、その注文は対応完了とみなす
export function isReviewComplete(flags: readonly ReviewFlag[]): boolean {
  return flags.every((flag) => flag.resolved);
}
