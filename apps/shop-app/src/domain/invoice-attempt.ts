// InvoiceAttempt.status の状態機械（design.md 4章、ADR 6）。
// BTCPay の invoice の状態を写したもので、例外なく前にしか進まない。

export const INVOICE_ATTEMPT_STATUSES = ["CREATING", "NEW", "PROCESSING", "SETTLED", "EXPIRED", "INVALID"] as const;
export type InvoiceAttemptStatus = (typeof INVOICE_ATTEMPT_STATUSES)[number];

// 1段の遷移。NEW → INVALID は、こちらで無効化した invoice（ADR 9）が Greenfield で INVALID に見える場合に通る
const NEXT: Record<InvoiceAttemptStatus, readonly InvoiceAttemptStatus[]> = {
  CREATING: ["NEW"],
  NEW: ["PROCESSING", "EXPIRED", "INVALID"],
  PROCESSING: ["SETTLED", "INVALID"],
  SETTLED: [],
  EXPIRED: [],
  INVALID: [],
};

// Webhook の取りこぼしで途中の状態を見ないことがあるので、何段先でも前に進むなら受け入れる
export function canAdvance(from: InvoiceAttemptStatus, to: InvoiceAttemptStatus): boolean {
  return NEXT[from].some((next) => next === to || canAdvance(next, to));
}

// Greenfield から取り直した状態を当てはめる。前に進まない（古い・同じ）状態は何もしない（no-op）
export function advanceAttempt(from: InvoiceAttemptStatus, observed: InvoiceAttemptStatus): InvoiceAttemptStatus {
  return canAdvance(from, observed) ? observed : from;
}

export function isTerminalAttempt(status: InvoiceAttemptStatus): boolean {
  return NEXT[status].length === 0;
}
