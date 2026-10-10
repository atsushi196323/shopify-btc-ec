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

// Invalid の invoice の入金の様子。invoice の状態には現れないので、payment-methods から読む（ADR 9 の検知方法）。
// 金額は10進数の文字列（BTC 建て）
export type InvalidInvoicePayment = { totalPaid: string; amount: string };

export function toObservation(
  status: string,
  additionalStatus: string,
  invalidPayment?: InvalidInvoicePayment,
): InvoiceObservation {
  const observed = STATUS[status];
  const received = RECEIVED[additionalStatus];
  // 知らない値を推測で変換すると誤った遷移になるので、止めて inbox の再処理に任せる
  if (!observed || !received) {
    throw new Error(`BTCPay の invoice の状態を変換できない: status=${status} additionalStatus=${additionalStatus}`);
  }
  // 無効化した invoice への入金は、additionalStatus が Marked のまま変わらない（ADR 9）
  if (observed === "INVALID" && additionalStatus === "Marked" && invalidPayment) {
    return { status: observed, received: receivedFromPaid(invalidPayment) };
  }
  // Processing と Settled は全額が届いている（過払いでなければ FULL）
  if ((observed === "PROCESSING" || observed === "SETTLED") && received === "NONE") {
    return { status: observed, received: "FULL" };
  }
  return { status: observed, received };
}

function receivedFromPaid({ totalPaid, amount }: InvalidInvoicePayment): InvoiceObservation["received"] {
  const paid = compareDecimal(totalPaid, "0");
  if (paid <= 0) return "NONE";
  const vsAmount = compareDecimal(totalPaid, amount);
  return vsAmount < 0 ? "PARTIAL" : vsAmount === 0 ? "FULL" : "OVER";
}

// 符号のない10進数の文字列を比べる。浮動小数点に変換すると、小さな差が丸めで消えることがある
export function compareDecimal(a: string, b: string): number {
  const [aInt, aFrac = ""] = normalize(a).split(".");
  const [bInt, bFrac = ""] = normalize(b).split(".");
  if (aInt.length !== bInt.length) return aInt.length < bInt.length ? -1 : 1;
  const width = Math.max(aFrac.length, bFrac.length);
  const left = aInt + aFrac.padEnd(width, "0");
  const right = bInt + bFrac.padEnd(width, "0");
  return left === right ? 0 : left < right ? -1 : 1;
}

function normalize(value: string): string {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`10進数の金額ではない: ${value}`);
  const [int, frac] = value.split(".");
  const trimmedInt = int.replace(/^0+(?=\d)/, "");
  const trimmedFrac = (frac ?? "").replace(/0+$/, "");
  return trimmedFrac ? `${trimmedInt}.${trimmedFrac}` : trimmedInt;
}
