import { describe, expect, it } from "vitest";
import { INVOICE_ATTEMPT_STATUSES, canAdvance } from "../../../src/domain/invoice-attempt";
import {
  applyObservation,
  canPaymentAdvance,
  hasPayment,
  reissue,
  type InvoiceObservation,
  type PaymentState,
} from "../../../src/domain/payment";

// 観測は「試行の状態 × 入金の様子」の全組み合わせ（25通り）
const RECEIVED: InvoiceObservation["received"][] = ["NONE", "PARTIAL", "FULL", "OVER", "LATE"];
const OBSERVATIONS: InvoiceObservation[] = INVOICE_ATTEMPT_STATUSES.filter((status) => status !== "CREATING").flatMap(
  (status) => RECEIVED.map((received) => ({ status: status as InvoiceObservation["status"], received })),
);

type Step = { attemptId: string; observation: InvoiceObservation };

// application 層の代わりに観測を順に当てる。無効化を求められたら、成功したものとして invalidatedByUs を立てる
function run(initial: PaymentState, steps: Step[]): PaymentState {
  let state = initial;
  for (const { attemptId, observation } of steps) {
    const before = state;
    const result = applyObservation(state, attemptId, observation);
    state = result.state;
    if (result.attemptToInvalidate) {
      const target = result.attemptToInvalidate;
      state = {
        ...state,
        attempts: state.attempts.map((a) => (a.id === target ? { ...a, invalidatedByUs: true } : a)),
      };
    }
    assertStepInvariants(before, state);
  }
  return state;
}

function assertStepInvariants(before: PaymentState, after: PaymentState) {
  // status は遷移表に沿ってしか進まず、終端から出ない
  expect(after.status === before.status || canPaymentAdvance(before.status, after.status)).toBe(true);
  // 試行は前にしか進まない
  for (const attempt of after.attempts) {
    const prev = before.attempts.find((a) => a.id === attempt.id)!;
    expect(attempt.status === prev.status || canAdvance(prev.status, attempt.status)).toBe(true);
  }
  // 不変条件1: UNRESOLVED ならフラグが1つ以上ある
  if (after.status === "UNRESOLVED") expect(after.flags.length).toBeGreaterThan(0);
  // 不変条件5: (reason, attemptId) の組は重複しない（DB のユニーク制約と同じ）
  const keys = after.flags.map((flag) => `${flag.reason}:${flag.attemptId}`);
  expect(new Set(keys).size).toBe(keys.length);
  // 一度付いたフラグは消えない
  expect(after.flags.slice(0, before.flags.length)).toEqual(before.flags);
}

function sequences<T>(items: T[], length: number): T[][] {
  if (length === 0) return [[]];
  return sequences(items, length - 1).flatMap((prefix) => items.map((item) => [...prefix, item]));
}

const fresh: PaymentState = {
  status: "CREATING",
  currentAttemptId: "a1",
  attempts: [{ id: "a1", status: "CREATING", invalidatedByUs: false }],
  flags: [],
};

function reissuedFromExpired(): PaymentState {
  const result = reissue(
    { ...fresh, status: "EXPIRED", attempts: [{ id: "a1", status: "EXPIRED", invalidatedByUs: false }] },
    "a2",
  );
  if (!result.ok) throw new Error("再発行に失敗した");
  return result.state;
}

describe("不変条件（網羅）", () => {
  it("試行が1つのとき: 観測を3回当てる全組み合わせで、遷移と不変条件が守られる", () => {
    const all = sequences(OBSERVATIONS, 3);
    for (const observations of all) {
      const state = run(
        fresh,
        observations.map((observation) => ({ attemptId: "a1", observation })),
      );
      // 試行が1つなら二重払いは起きない
      expect(state.flags.some((flag) => flag.reason === "DOUBLE_PAYMENT")).toBe(false);
    }
    expect(all).toHaveLength(25 ** 3);
  });

  it("再発行の後: 2つの試行に観測を3回当てる全組み合わせで、両方に入金があれば DOUBLE_PAYMENT がちょうど1件付く（不変条件2）", () => {
    const steps: Step[] = ["a1", "a2"].flatMap((attemptId) => OBSERVATIONS.map((observation) => ({ attemptId, observation })));
    for (const sequence of sequences(steps, 3)) {
      const state = run(reissuedFromExpired(), sequence);
      const doubles = state.flags.filter((flag) => flag.reason === "DOUBLE_PAYMENT");
      if (hasPayment(state, "a1") && hasPayment(state, "a2")) {
        expect(doubles).toHaveLength(1);
      } else if (doubles.length > 0) {
        // 逆向き: 入金が片方にしかないのに付いているなら、相手の入金が後から取り消された（INVALID_PAYMENT）場合だけ。
        // フラグは事象の記録なので消さず、status は UNRESOLVED で人の対応に回る
        expect(doubles).toHaveLength(1);
        const related = doubles[0].relatedAttemptId;
        expect(state.flags.some((flag) => flag.reason === "INVALID_PAYMENT" && flag.attemptId === related)).toBe(true);
        expect(state.status).toBe("UNRESOLVED");
      }
    }
    // 50³ 通りを回すので、既定の 5 秒では足りない
  }, 30_000);
});

describe("二重払いの処理順（不変条件2・3）", () => {
  // 古い試行 a1 への期限後の入金と、新しい試行 a2 の正常な支払いを、すべての順番で処理する
  const late: Step = { attemptId: "a1", observation: { status: "EXPIRED", received: "LATE" } };
  const a2Steps: Step[] = [
    { attemptId: "a2", observation: { status: "NEW", received: "NONE" } },
    { attemptId: "a2", observation: { status: "PROCESSING", received: "FULL" } },
    { attemptId: "a2", observation: { status: "SETTLED", received: "FULL" } },
  ];

  it.each([0, 1, 2, 3])("a1 の入金を %i 番目に処理しても、DOUBLE_PAYMENT はちょうど1件で、後に処理された側に付く", (position) => {
    const steps = [...a2Steps.slice(0, position), late, ...a2Steps.slice(position)];

    const state = run(reissuedFromExpired(), steps);

    const doubles = state.flags.filter((flag) => flag.reason === "DOUBLE_PAYMENT");
    expect(doubles).toHaveLength(1);
    // a2 が入金済み（PROCESSING 以降）になる前に a1 を処理したら、後になったのは a2
    const later = position <= 1 ? "a2" : "a1";
    expect(doubles[0]).toMatchObject({ attemptId: later, relatedAttemptId: later === "a1" ? "a2" : "a1" });
    // status は順番によって PAID にも UNRESOLVED にもなる（どちらも人の対応に回る）
    expect(state.status).toBe(position <= 1 ? "UNRESOLVED" : "PAID");
  });
});
