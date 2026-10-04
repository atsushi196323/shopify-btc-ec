// Payment の状態とフラグの判定（design.md 4章・6章、ADR 6・9）。
// 1件の試行について Greenfield から取り直した invoice の様子を受け取り、次の状態・追加するフラグ・無効化すべき試行を返す。
// 副作用は持たない。DB への保存・version・shopifySync の更新・BTCPay の呼び出しは application 層が行う。

import { advanceAttempt, type InvoiceAttemptStatus } from "./invoice-attempt";
import { hasFlag, type NewReviewFlag, type ReviewFlag, type ReviewReason } from "./review-flag";

export const PAYMENT_STATUSES = ["CREATING", "AWAITING_PAYMENT", "CONFIRMING", "PAID", "EXPIRED", "UNRESOLVED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// design.md 4章の遷移表のうち、イベントが起点の遷移。EXPIRED → CREATING（再発行）はコマンドが起点なので reissue() だけが行う
const EVENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATING: ["AWAITING_PAYMENT"],
  AWAITING_PAYMENT: ["CONFIRMING", "EXPIRED", "UNRESOLVED"],
  CONFIRMING: ["PAID", "UNRESOLVED"],
  EXPIRED: ["UNRESOLVED"],
  PAID: [],
  UNRESOLVED: [],
};

// 試行と同じく、途中の状態を飛ばして前に進むことを許す
export function canPaymentAdvance(from: PaymentStatus, to: PaymentStatus): boolean {
  return EVENT_TRANSITIONS[from].some((next) => next === to || canPaymentAdvance(next, to));
}

export type AttemptState = {
  id: string;
  status: InvoiceAttemptStatus;
  invalidatedByUs: boolean;
};

export type PaymentState = {
  status: PaymentStatus;
  currentAttemptId: string;
  attempts: readonly AttemptState[];
  flags: readonly ReviewFlag[];
};

// Greenfield の invoice から読み取った様子。BTCPay の型には依存せず、アダプタがこの形に変換する
export type InvoiceObservation = {
  status: Exclude<InvoiceAttemptStatus, "CREATING">;
  // NONE: 入金なし / PARTIAL: 一部入金 / FULL: 全額 / OVER: 過払い / LATE: 期限後の入金
  received: "NONE" | "PARTIAL" | "FULL" | "OVER" | "LATE";
};

export type ObservationResult = {
  state: PaymentState;
  newFlags: NewReviewFlag[];
  statusChanged: boolean;
  attemptStatusChanged: boolean;
  // status かフラグが変わったら、Shopify への反映待ち（shopifySync = PENDING）にする
  needsShopifySync: boolean;
  // UNRESOLVED になったのに現在の試行が未入金のまま有効なら、その invoice を無効化する
  attemptToInvalidate: string | null;
};

// 試行に入金があったことを示すフラグ。INVALID_PAYMENT（二重支払い・RBF）は入金が取り消されたので含めない
const PAYMENT_EVIDENCE: readonly ReviewReason[] = ["UNDERPAID", "LATE_PAYMENT", "DOUBLE_PAYMENT", "OVERPAID"];

// 試行に入金があったか。試行の状態か、その試行に付いたフラグから導出する（専用の列は持たない）
export function hasPayment(state: Pick<PaymentState, "attempts" | "flags">, attemptId: string): boolean {
  const attempt = findAttempt(state, attemptId);
  return (
    attempt.status === "PROCESSING" ||
    attempt.status === "SETTLED" ||
    state.flags.some((flag) => flag.attemptId === attemptId && PAYMENT_EVIDENCE.includes(flag.reason))
  );
}

export function attemptToInvalidate(state: PaymentState): string | null {
  const current = findAttempt(state, state.currentAttemptId);
  return state.status === "UNRESOLVED" && current.status === "NEW" ? current.id : null;
}

export function applyObservation(
  state: PaymentState,
  attemptId: string,
  observation: InvoiceObservation,
): ObservationResult {
  const before = findAttempt(state, attemptId);
  const isCurrent = attemptId === state.currentAttemptId;
  const nextAttemptStatus = advanceAttempt(before.status, observation.status);

  const newFlags: NewReviewFlag[] = [];
  const addFlag = (reason: ReviewReason, relatedAttemptId: string | null = null) => {
    // 不変条件5: 同じ事象は、対応済みでも新しい行にしない
    if (hasFlag(state.flags, reason, attemptId) || newFlags.some((flag) => flag.reason === reason)) return;
    newFlags.push({ reason, attemptId, relatedAttemptId });
  };

  const paidBefore = hasPayment(state, attemptId);
  const paidNow =
    paidBefore ||
    observation.received !== "NONE" ||
    nextAttemptStatus === "PROCESSING" ||
    nextAttemptStatus === "SETTLED";
  const otherPaidAttempt = state.attempts.find((other) => other.id !== attemptId && hasPayment(state, other.id));

  // 不変条件2・3: 入金を初めて検知した試行の処理が後になった側。相手に入金があれば、こちらに DOUBLE_PAYMENT を付ける
  if (!paidBefore && paidNow && otherPaidAttempt) {
    addFlag("DOUBLE_PAYMENT", otherPaidAttempt.id);
  }

  if (observation.received === "OVER") addFlag("OVERPAID");

  let target: PaymentStatus = state.status;
  if (isCurrent) {
    switch (nextAttemptStatus) {
      case "NEW":
        target = "AWAITING_PAYMENT";
        break;
      case "PROCESSING":
        target = "CONFIRMING";
        break;
      case "SETTLED":
        target = "PAID";
        break;
      case "EXPIRED":
        if (observation.received === "PARTIAL") {
          addFlag("UNDERPAID");
          target = "UNRESOLVED";
        } else if (observation.received !== "NONE") {
          // 期限後の入金は、レートが変わっているので自動では支払い済みにしない（ADR 9）
          addFlag("LATE_PAYMENT");
          target = "UNRESOLVED";
        } else {
          target = "EXPIRED";
        }
        break;
      case "INVALID":
        // こちらで無効化した invoice が INVALID になるのは想定どおり。入金があれば上の DOUBLE_PAYMENT で拾う
        if (!before.invalidatedByUs && paidNow) {
          addFlag("INVALID_PAYMENT");
          target = "UNRESOLVED";
        }
        break;
      case "CREATING":
        break;
    }
  } else if (!paidBefore && paidNow && !otherPaidAttempt) {
    // 古い試行に期限後の入金があり、ほかの試行は未入金（design.md 4章「古い試行に期限後の入金があったとき」）
    addFlag("LATE_PAYMENT");
    target = "UNRESOLVED";
  }

  const nextStatus = canPaymentAdvance(state.status, target) ? target : state.status;
  const nextState: PaymentState = {
    ...state,
    status: nextStatus,
    attempts: state.attempts.map((attempt) =>
      attempt.id === attemptId ? { ...attempt, status: nextAttemptStatus } : attempt,
    ),
    flags: [...state.flags, ...newFlags.map((flag) => ({ ...flag, resolved: false }))],
  };

  // 不変条件1: UNRESOLVED ならフラグが1つ以上ある。ここに来るのは判定の誤りなので、保存させずに止める
  if (nextState.status === "UNRESOLVED" && nextState.flags.length === 0) {
    throw new Error("不変条件1の違反: フラグのない UNRESOLVED");
  }

  const statusChanged = nextStatus !== state.status;
  return {
    state: nextState,
    newFlags,
    statusChanged,
    attemptStatusChanged: nextAttemptStatus !== before.status,
    needsShopifySync: statusChanged || newFlags.length > 0,
    attemptToInvalidate: attemptToInvalidate(nextState),
  };
}

export type ReissueResult = { ok: true; state: PaymentState } | { ok: false; reason: "NOT_EXPIRED" };

// 再発行（design.md 5.4）。新しい試行を CREATING で作り、ポインタを付け替える。どの試行も後ろには戻らない
export function reissue(state: PaymentState, newAttemptId: string): ReissueResult {
  if (state.status !== "EXPIRED") return { ok: false, reason: "NOT_EXPIRED" };
  if (state.attempts.some((attempt) => attempt.id === newAttemptId)) {
    throw new Error(`試行 ${newAttemptId} はすでに存在する`);
  }
  return {
    ok: true,
    state: {
      ...state,
      status: "CREATING",
      currentAttemptId: newAttemptId,
      attempts: [...state.attempts, { id: newAttemptId, status: "CREATING", invalidatedByUs: false }],
    },
  };
}

function findAttempt(state: Pick<PaymentState, "attempts">, attemptId: string): AttemptState {
  const attempt = state.attempts.find((candidate) => candidate.id === attemptId);
  if (!attempt) throw new Error(`試行 ${attemptId} はこの Payment のものではない`);
  return attempt;
}
