// invoice の作成（design.md 5.1、ADR 5）と、CREATING のまま残った試行の回復（design.md 5.5 の 1）。
// 予約行で同時実行を排除し、BTCPay の呼び出しは予約の commit の後に行う。
import { randomUUID } from "node:crypto";
import { applyObservation } from "../domain/payment";
import type { BtcpayGateway, BtcpayInvoice } from "./ports/btcpay-gateway";
import type { AttemptSnapshot, PaymentRepository, PaymentSnapshot } from "./ports/payment-repository";
import type { ShopifyGateway } from "./ports/shopify-gateway";

export type InvoiceDeps = {
  payments: PaymentRepository;
  btcpay: BtcpayGateway;
  shopify: ShopifyGateway;
  newId?: () => string;
};

// CREATED: この呼び出しが予約に勝ち、BTCPay に invoice を作った
// EXISTING: Payment がすでにあった（作成中の CREATING も含む。拡張は CREATING ならリトライする）
export type CreateInvoiceResult =
  | { outcome: "CREATED"; payment: PaymentSnapshot; invoice: BtcpayInvoice }
  | { outcome: "EXISTING"; payment: PaymentSnapshot }
  | { outcome: "ORDER_NOT_FOUND" };

// orders/create Webhook と拡張 API の両方から呼ぶ。
// BTCPay の呼び出しや紐づけで例外が出たら、試行は CREATING のまま残り、スイープの孤児回復が追いつかせる（ADR 5）
export async function createInvoiceForOrder(deps: InvoiceDeps, shopifyOrderId: string): Promise<CreateInvoiceResult> {
  const existing = await deps.payments.findByShopifyOrderId(shopifyOrderId);
  if (existing) return { outcome: "EXISTING", payment: existing };

  // 請求額は必ず Admin API から取り直す（ADR 4）
  const order = await deps.shopify.getOrder(shopifyOrderId);
  if (!order) return { outcome: "ORDER_NOT_FOUND" };

  const newId = deps.newId ?? randomUUID;
  const reservation = await deps.payments.reserve({ paymentId: newId(), attemptId: newId(), shopifyOrderId });
  if (!reservation.reserved) return { outcome: "EXISTING", payment: reservation.payment };

  const attemptId = reservation.payment.currentAttempt.id;
  const invoice = await deps.btcpay.createInvoice({
    attemptId,
    shopifyOrderId,
    amount: order.outstanding.amount,
    currency: order.outstanding.currencyCode,
  });
  const attached = await attach(deps, attemptId, invoice);
  // 紐づけに負けたのは、この呼び出しが遅れている間にスイープが回復した場合。勝った側の invoice を正とする
  return attached.attached
    ? { outcome: "CREATED", payment: attached.payment, invoice }
    : { outcome: "EXISTING", payment: attached.payment };
}

// RECOVERED: BTCPay に invoice が見つかったので紐づけた / RECREATED: 見つからなかったので作り直した
// ALREADY_ATTACHED: 試行はすでに CREATING でなかった
export type RecoverAttemptResult =
  | { outcome: "RECOVERED" | "RECREATED"; payment: PaymentSnapshot }
  | { outcome: "ALREADY_ATTACHED" }
  | { outcome: "ORDER_NOT_FOUND" };

// スイープが、CREATING のまま一定時間が経った試行に対して呼ぶ（design.md 5.5 の 1）。初回の作成と再発行のどちらの試行にも使う。
// 取得ではなく検索を使う。ストアにない invoice の取得は 403 になり、「見つからない」と区別できないため（ADR 5）
export async function recoverCreatingAttempt(deps: InvoiceDeps, attemptId: string): Promise<RecoverAttemptResult> {
  const attempt = await deps.payments.findAttempt(attemptId);
  if (!attempt) throw new Error(`試行 ${attemptId} がない`);
  if (!isUnattached(attempt)) return { outcome: "ALREADY_ATTACHED" };

  const found = await deps.btcpay.findInvoicesByAttemptId(attemptId);
  if (found.length > 0) {
    // 同じ試行に invoice が2つできるのは、作成中の呼び出しとスイープの作り直しが重なった場合だけ。
    // 紐づけるのは1つで、残りは試行に結びつかないまま BTCPay に残る（ADR 5 に記録）
    const attached = await attach(deps, attemptId, found[0]);
    return attached.attached ? { outcome: "RECOVERED", payment: attached.payment } : { outcome: "ALREADY_ATTACHED" };
  }

  const order = await deps.shopify.getOrder(attempt.shopifyOrderId);
  if (!order) return { outcome: "ORDER_NOT_FOUND" };
  const invoice = await deps.btcpay.createInvoice({
    attemptId,
    shopifyOrderId: attempt.shopifyOrderId,
    amount: order.outstanding.amount,
    currency: order.outstanding.currencyCode,
  });
  const attached = await attach(deps, attemptId, invoice);
  return attached.attached ? { outcome: "RECREATED", payment: attached.payment } : { outcome: "ALREADY_ATTACHED" };
}

function isUnattached(attempt: AttemptSnapshot): boolean {
  return attempt.status === "CREATING" && attempt.btcpayInvoiceId === null;
}

// 回復で見つかった invoice は NEW とは限らない（すでに入金・期限切れのこともある）ので、遷移とフラグはドメインで判定する
function attach(deps: InvoiceDeps, attemptId: string, invoice: BtcpayInvoice) {
  return deps.payments.attachInvoice({
    attemptId,
    btcpayInvoiceId: invoice.invoiceId,
    decide: (state) => applyObservation(state, attemptId, invoice.observation),
  });
}
