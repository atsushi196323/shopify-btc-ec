// Greenfield の invoice の status / additionalStatus を、ドメインの InvoiceObservation に変換する（ADR 6）。
// 支払い方法に依存しない値だけを使うので、Lightning を足しても変わらない（ADR 2）。
import type { InvoiceObservation } from "../../domain/payment";

const STATUS: Record<string, InvoiceObservation["status"]> = {
  New: "NEW",
  Processing: "PROCESSING",
  Settled: "SETTLED",
  Expired: "EXPIRED",
  Invalid: "INVALID",
};

// Marked（管理画面で手動で状態を変えた）と Invalid は、入金の様子を表さないので NONE として扱う
const RECEIVED: Record<string, InvoiceObservation["received"]> = {
  None: "NONE",
  Marked: "NONE",
  Invalid: "NONE",
  PaidPartial: "PARTIAL",
  PaidOver: "OVER",
  PaidLate: "LATE",
};

export function toObservation(status: string, additionalStatus: string): InvoiceObservation {
  const observed = STATUS[status];
  const received = RECEIVED[additionalStatus];
  // 知らない値を推測で変換すると誤った遷移になるので、止めて inbox の再処理に任せる
  if (!observed || !received) {
    throw new Error(`BTCPay の invoice の状態を変換できない: status=${status} additionalStatus=${additionalStatus}`);
  }
  // Processing と Settled は全額が届いている（過払いでなければ FULL）
  if ((observed === "PROCESSING" || observed === "SETTLED") && received === "NONE") {
    return { status: observed, received: "FULL" };
  }
  return { status: observed, received };
}
