// 拡張 API（design.md 5.2、ADR 4）。Thank you ページの拡張に、checkout link と表示用の状態だけを返す。
// Payment がまだなければ、ここで invoice を作る（遅延作成。design.md 5.1 の起点の2つめ）。
import type { PaymentStatus } from "../domain/payment";
import { createInvoiceForOrder, type InvoiceDeps } from "./create-invoice";
import type { PaymentSnapshot } from "./ports/payment-repository";

// 拡張に返す表示状態。ADR 4 のとおり、金額・試行・フラグの中身は返さない
// PREPARING: invoice の作成中、または注文がまだ Admin API で見えない。拡張は時間をおいて問い合わせ直す
// AWAITING_PAYMENT: 支払い待ち / CONFIRMING: 入金確認中 / PAID: 支払い済み
// EXPIRED: 期限切れ（再発行できる。再発行は W3） / CONTACT_SHOP: ショップから連絡します
// NOT_APPLICABLE: invoice を作らない注文（Bitcoin 以外の支払い方法・キャンセル済みなど）。拡張は何も表示しない
type StateOnly = "PREPARING" | "CONFIRMING" | "PAID" | "EXPIRED" | "CONTACT_SHOP" | "NOT_APPLICABLE";
export type ExtensionView = { state: StateOnly } | { state: "AWAITING_PAYMENT"; checkoutLink: string };

export async function invoiceForExtension(deps: InvoiceDeps, shopifyOrderId: string): Promise<ExtensionView> {
  // 拡張から届いた shopifyOrderId は信用しない。セッショントークンのショップの Admin API で取れる注文だけを扱う。
  // ここで確かめないと、別のショップの注文の状態を返しうる
  const order = await deps.shopify.getOrder(shopifyOrderId);
  // Thank you ページの表示は注文の作成と同時なので、Admin API でまだ見えないことがある。待ってから問い合わせ直してもらう
  if (!order) return { state: "PREPARING" };

  const existing = await deps.payments.findByShopifyOrderId(shopifyOrderId);
  if (existing) return view(deps, existing, null);

  // Payment がまだないときだけ作る。CREATING の Payment は自分では回復せず、拡張に待ってもらう（design.md 5.1）
  const result = await createInvoiceForOrder(deps, shopifyOrderId);
  switch (result.outcome) {
    case "CREATED":
      return view(deps, result.payment, result.invoice.checkoutLink);
    case "EXISTING":
      return view(deps, result.payment, null);
    case "ORDER_NOT_FOUND":
      return { state: "PREPARING" };
    case "NOT_ELIGIBLE":
      return { state: "NOT_APPLICABLE" };
  }
}

const VIEW_STATES: Record<Exclude<PaymentStatus, "AWAITING_PAYMENT">, StateOnly> = {
  CREATING: "PREPARING",
  CONFIRMING: "CONFIRMING",
  PAID: "PAID",
  EXPIRED: "EXPIRED",
  UNRESOLVED: "CONTACT_SHOP",
};

// checkout link は DB に持たないので、支払い待ちのときだけ BTCPay から取る（作った直後は作成の結果を使う）
async function view(deps: InvoiceDeps, payment: PaymentSnapshot, createdLink: string | null): Promise<ExtensionView> {
  if (payment.status !== "AWAITING_PAYMENT") return { state: VIEW_STATES[payment.status] };
  const invoiceId = payment.currentAttempt.btcpayInvoiceId;
  // AWAITING_PAYMENT になるのは試行に invoice を紐づけたときだけなので、ここには来ない
  if (invoiceId === null) throw new Error(`Payment ${payment.paymentId} は支払い待ちなのに invoice がない`);
  const checkoutLink = createdLink ?? (await deps.btcpay.getInvoice(invoiceId)).checkoutLink;
  return { state: "AWAITING_PAYMENT", checkoutLink };
}
