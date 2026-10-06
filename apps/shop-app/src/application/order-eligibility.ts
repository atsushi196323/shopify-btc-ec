// invoice を作れる注文かどうかの判断（ADR 4）。Admin API から取り直した注文に対して行う。
// 拡張から届いた shopifyOrderId は信用しないので、invoice を作る経路はすべてここを通す
import type { ShopifyOrder } from "./ports/shopify-gateway";

// 管理画面で作った手動決済方法の名前（ADR 1）。比べるときは空白と全角・半角の違いを無視する（ADR 4）
export const BITCOIN_GATEWAY_NAME = "Bitcoinで支払う";
// BTCPay のレートは BTC_JPY だけなので、JPY 以外の注文には invoice を作れない（ADR 4）
export const INVOICE_CURRENCY = "JPY";
// PARTIALLY_PAID も受け付ける。一部が別の方法で支払われた注文には、残高だけを請求する（ADR 4）
const PAYABLE_FINANCIAL_STATUSES = ["PENDING", "PARTIALLY_PAID"];

export type IneligibleReason =
  | "NOT_BITCOIN_ORDER"
  | "CANCELLED"
  | "NOT_AWAITING_PAYMENT"
  | "UNSUPPORTED_CURRENCY"
  | "NOTHING_OUTSTANDING";

export type OrderEligibility = { eligible: true } | { eligible: false; reason: IneligibleReason };

export function checkOrderEligibility(order: ShopifyOrder): OrderEligibility {
  if (!order.paymentGatewayNames.some(isBitcoinGateway)) return ineligible("NOT_BITCOIN_ORDER");
  if (order.cancelled) return ineligible("CANCELLED");
  if (!PAYABLE_FINANCIAL_STATUSES.includes(order.financialStatus)) return ineligible("NOT_AWAITING_PAYMENT");
  // 残高は常にショップの通貨なので、それだけでは客が別の通貨で注文したことを見落とす。両方を確かめる
  if (order.presentmentCurrencyCode !== INVOICE_CURRENCY || order.outstanding.currencyCode !== INVOICE_CURRENCY) {
    return ineligible("UNSUPPORTED_CURRENCY");
  }
  if (!(Number(order.outstanding.amount) > 0)) return ineligible("NOTHING_OUTSTANDING");
  return { eligible: true };
}

// 「Bitcoin で支払う」「Ｂｉｔｃｏｉｎで支払う」なども同じ名前とみなす。テスト注文で空白の有無が食い違ったため（ADR 4）
function isBitcoinGateway(name: string): boolean {
  return normalizeGatewayName(name) === normalizeGatewayName(BITCOIN_GATEWAY_NAME);
}

function normalizeGatewayName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "");
}

function ineligible(reason: IneligibleReason): OrderEligibility {
  return { eligible: false, reason };
}
