// invoice の作成（design.md 5.1、ADR 5）と、CREATING のまま残った試行の回復（design.md 5.5 の 1）。
// 予約行で同時実行を排除し、BTCPay の呼び出しは予約の commit の後に行う。
import { randomUUID } from "node:crypto";
import { applyObservation, reissue } from "../domain/payment";
import { invalidateAttempt } from "./invalidate-attempt";
import { checkOrderEligibility, type IneligibleReason } from "./order-eligibility";
import { MAX_CONFLICT_RETRIES } from "./retry-limits";
import type { BtcpayGateway, BtcpayInvoice } from "./ports/btcpay-gateway";
import type { AttemptSnapshot, PaymentRepository, PaymentSnapshot } from "./ports/payment-repository";
import type { ShopifyGateway } from "./ports/shopify-gateway";

export type InvoiceDeps = {
  // 注文のショップ。shopify はこのショップで認証済みのもの
  shop: string;
  payments: PaymentRepository;
  btcpay: BtcpayGateway;
  shopify: ShopifyGateway;
  newId?: () => string;
};

// CREATED: この呼び出しが予約に勝ち、BTCPay に invoice を作った
// EXISTING: Payment がすでにあった（作成中の CREATING も含む。拡張は CREATING ならリトライする）
// NOT_ELIGIBLE: invoice を作れない注文（Bitcoin 以外の支払い方法・キャンセル済みなど）。Payment は作らない
export type CreateInvoiceResult =
  | { outcome: "CREATED"; payment: PaymentSnapshot; invoice: BtcpayInvoice }
  | { outcome: "EXISTING"; payment: PaymentSnapshot }
  | OrderRejection;

export type OrderRejection = { outcome: "ORDER_NOT_FOUND" } | { outcome: "NOT_ELIGIBLE"; reason: IneligibleReason };

// orders/create Webhook と拡張 API の両方から呼ぶ。
// BTCPay の呼び出しや紐づけで例外が出たら、試行は CREATING のまま残り、スイープの孤児回復が追いつかせる（ADR 5）
export async function createInvoiceForOrder(deps: InvoiceDeps, shopifyOrderId: string): Promise<CreateInvoiceResult> {
  const existing = await deps.payments.findByShopifyOrderId(shopifyOrderId);
  if (existing) return { outcome: "EXISTING", payment: existing };

  const order = await fetchPayableOrder(deps, shopifyOrderId);
  if (!order.payable) return order.rejection;

  const newId = deps.newId ?? randomUUID;
  const reservation = await deps.payments.reserve({
    paymentId: newId(),
    attemptId: newId(),
    shop: deps.shop,
    shopifyOrderId,
  });
  if (!reservation.reserved) return { outcome: "EXISTING", payment: reservation.payment };

  const attemptId = reservation.payment.currentAttempt.id;
  const invoice = await deps.btcpay.createInvoice({ attemptId, shopifyOrderId, ...order.amount });
  const attached = await attach(deps, attemptId, invoice);
  // 紐づけに負けたのは、この呼び出しが遅れている間にスイープが回復した場合。勝った側の invoice を正とする
  return attached.attached
    ? { outcome: "CREATED", payment: attached.payment, invoice }
    : { outcome: "EXISTING", payment: attached.payment };
}

// RECOVERED: BTCPay に invoice が見つかったので紐づけた / RECREATED: 見つからなかったので作り直した
// ALREADY_ATTACHED: 試行はすでに CREATING でなかった
// ORDER_NOT_FOUND・NOT_ELIGIBLE: 作り直す前に注文を確かめ直したら、invoice を作れなかった。試行は CREATING のまま残る
export type RecoverAttemptResult =
  | { outcome: "RECOVERED" | "RECREATED"; payment: PaymentSnapshot }
  | { outcome: "ALREADY_ATTACHED" }
  | OrderRejection;

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

  // 予約から時間が経っているので、作り直す前に注文を確かめ直す（その間にキャンセル・別の方法での支払いがありうる）
  const order = await fetchPayableOrder(deps, attempt.shopifyOrderId);
  if (!order.payable) return order.rejection;
  const invoice = await deps.btcpay.createInvoice({ attemptId, shopifyOrderId: attempt.shopifyOrderId, ...order.amount });
  const attached = await attach(deps, attemptId, invoice);
  return attached.attached ? { outcome: "RECREATED", payment: attached.payment } : { outcome: "ALREADY_ATTACHED" };
}

// REISSUED: 新しい試行を作り、BTCPay に invoice を作った
// NOT_EXPIRED: Payment が EXPIRED でなかった（再発行済み・入金があったなど）。今の Payment を返す
// PAYMENT_NOT_FOUND: この注文の Payment がない
export type ReissueInvoiceResult =
  | { outcome: "REISSUED"; payment: PaymentSnapshot; invoice: BtcpayInvoice }
  | { outcome: "NOT_EXPIRED"; payment: PaymentSnapshot }
  | { outcome: "PAYMENT_NOT_FOUND" }
  | OrderRejection;

// 再発行（design.md 5.4）。起点は拡張の「invoice を再発行」ボタンで、Payment が EXPIRED のときだけ受け付ける。
// 1つのトランザクションで新しい試行を作ってポインタを付け替え、commit の後に BTCPay を呼ぶ（5.1 の 4 以降と同じ）。
// BTCPay の呼び出しや紐づけで例外が出たら、新しい試行は CREATING のまま残り、スイープの孤児回復が追いつかせる
export async function reissueInvoice(deps: InvoiceDeps, shopifyOrderId: string): Promise<ReissueInvoiceResult> {
  let current = await deps.payments.findByShopifyOrderId(shopifyOrderId);
  // 別のショップの Payment は、ないものとして扱う（拡張から届いた shopifyOrderId は信用しない。ADR 4）
  if (!current || current.shop !== deps.shop) return { outcome: "PAYMENT_NOT_FOUND" };
  if (current.status !== "EXPIRED") return { outcome: "NOT_EXPIRED", payment: current };

  // 請求額は取り直す。レートは BTCPay が invoice を作るときに取り直す（ADR 9）
  const order = await fetchPayableOrder(deps, shopifyOrderId);
  if (!order.payable) return order.rejection;

  const newId = deps.newId ?? randomUUID;
  for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
    const loaded = await deps.payments.loadForAttempt(current.currentAttempt.id);
    if (!loaded) throw new Error(`試行 ${current.currentAttempt.id} がない`);
    const newAttemptId = newId();
    const reissued = reissue(loaded.state, newAttemptId);
    // 注文を確かめている間に、別の再発行や期限後の入金で EXPIRED でなくなった。今の Payment を読み直して返す
    if (!reissued.ok) {
      const latest = await deps.payments.findByShopifyOrderId(shopifyOrderId);
      if (!latest) throw new Error(`注文 ${shopifyOrderId} の Payment が消えた`);
      return { outcome: "NOT_EXPIRED", payment: latest };
    }

    const saved = await deps.payments.saveReissue({
      paymentId: loaded.paymentId,
      expectedVersion: loaded.version,
      state: reissued.state,
    });
    if (!saved.saved) {
      // 読んだ後に別の処理が更新した。保存しなかった側が返す今の Payment で判定し直す
      current = saved.payment;
      continue;
    }

    const invoice = await deps.btcpay.createInvoice({ attemptId: newAttemptId, shopifyOrderId, ...order.amount });
    const attached = await attach(deps, newAttemptId, invoice);
    // 紐づけに負けたのは、この呼び出しが遅れている間にスイープが回復した場合。勝った側の invoice を正とする
    return attached.attached
      ? { outcome: "REISSUED", payment: attached.payment, invoice }
      : { outcome: "NOT_EXPIRED", payment: attached.payment };
  }
  throw new Error(`version の競合が ${MAX_CONFLICT_RETRIES} 回続いた`);
}

type PayableOrder =
  | { payable: true; amount: { amount: string; currency: string } }
  | { payable: false; rejection: OrderRejection };

// 請求額は必ず Admin API から取り直し、invoice を作れる注文かを確かめる（ADR 4）。invoice を作る経路はすべてここを通す
async function fetchPayableOrder(deps: InvoiceDeps, shopifyOrderId: string): Promise<PayableOrder> {
  const order = await deps.shopify.getOrder(shopifyOrderId);
  if (!order) return { payable: false, rejection: { outcome: "ORDER_NOT_FOUND" } };
  const eligibility = checkOrderEligibility(order);
  if (!eligibility.eligible) {
    return { payable: false, rejection: { outcome: "NOT_ELIGIBLE", reason: eligibility.reason } };
  }
  return { payable: true, amount: { amount: order.outstanding.amount, currency: order.outstanding.currencyCode } };
}

function isUnattached(attempt: AttemptSnapshot): boolean {
  return attempt.status === "CREATING" && attempt.btcpayInvoiceId === null;
}

// 回復で見つかった invoice は NEW とは限らない（すでに入金・期限切れのこともある）ので、遷移とフラグはドメインで判定する
async function attach(deps: InvoiceDeps, attemptId: string, invoice: BtcpayInvoice) {
  const attached = await deps.payments.attachInvoice({
    attemptId,
    btcpayInvoiceId: invoice.invoiceId,
    decide: (state) => applyObservation(state, attemptId, invoice.observation),
  });
  // 作成中（CREATING）に古い試行へ期限後の入金があり、Payment が先に UNRESOLVED になっていた場合、紐づけた invoice は無効化する。
  // 失敗しても invalidatedByUs は残り、スイープが呼び直す（ADR 9）
  if (attached.attemptToInvalidate === attemptId) {
    await invalidateAttempt(deps, attemptId).catch((error: unknown) => {
      console.error(`試行 ${attemptId} の無効化に失敗した`, error);
    });
  }
  return attached;
}
