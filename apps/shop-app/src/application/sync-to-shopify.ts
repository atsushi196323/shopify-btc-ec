// Shopify への反映（design.md 4章「Shopify への反映」、ADR 8 の決定4）。
// 遷移が起きた瞬間に1回だけ呼ぶのではなく、shopifySync = PENDING の Payment を追いつかせる。
// どの手順も冪等なので、イベント処理の commit の直後とスイープのどちらから、何度呼んでも同じ結果になる
import type { ReviewReason } from "../domain/review-flag";
import type { PaymentRepository } from "./ports/payment-repository";
import type { ShopifyGateway, ShopifyGatewayForShop } from "./ports/shopify-gateway";

// 反映中に別の変更が入って DONE にできなかったとき、読み直して反映し直す回数
export const MAX_SYNC_ROUNDS = 3;

export type ShopifySyncDeps = {
  payments: PaymentRepository;
  shopifyFor: ShopifyGatewayForShop;
};

// SYNCED: 反映して DONE にした / NOT_PENDING: すでに DONE だった
// SUPERSEDED: 反映し直しても別の変更が続いた（PENDING のまま。次の反映かスイープが追いつかせる）
// FAILED: Shopify の呼び出しに失敗し、shopifySyncError に記録した（PENDING のまま）
export type ShopifySyncResult =
  | { outcome: "SYNCED" | "NOT_PENDING" | "SUPERSEDED" }
  | { outcome: "FAILED"; error: string };

// 同じ Payment の反映を、このプロセスの中で順番に流す。並行した2つの反映が、どちらも未払いと見て orderMarkAsPaid を2回呼ばないようにする。
// ワーカーとスイープは同じプロセスで動く（水平スケールは考慮しない。既知の制限）
const inFlight = new Map<string, Promise<unknown>>();

export function syncPaymentToShopify(deps: ShopifySyncDeps, paymentId: string): Promise<ShopifySyncResult> {
  const previous = inFlight.get(paymentId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => sync(deps, paymentId));
  inFlight.set(paymentId, current);
  return current.finally(() => {
    if (inFlight.get(paymentId) === current) inFlight.delete(paymentId);
  });
}

async function sync(deps: ShopifySyncDeps, paymentId: string): Promise<ShopifySyncResult> {
  for (let i = 0; i < MAX_SYNC_ROUNDS; i++) {
    const payment = await deps.payments.loadForSync(paymentId);
    if (!payment) throw new Error(`Payment ${paymentId} がない`);
    if (payment.shopifySync !== "PENDING") return { outcome: "NOT_PENDING" };

    try {
      const shopify = await deps.shopifyFor(payment.shop);
      // タグを先に付ける。支払い済みにできない注文（キャンセル済みなど）でも、人が対応すべき異常は Shopify で見えるようにする
      const tags = payment.unresolvedReasons.map(reviewTag);
      if (tags.length > 0) await shopify.addOrderTags(payment.shopifyOrderId, tags);
      if (payment.status === "PAID") await markAsPaid(shopify, payment.shopifyOrderId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.payments.recordSyncError(paymentId, message);
      return { outcome: "FAILED", error: message };
    }

    // 読んだときの version のままなら DONE にする。反映中に別の変更が入っていたら、読み直して反映し直す
    if (await deps.payments.markSynced(paymentId, payment.version)) return { outcome: "SYNCED" };
  }
  return { outcome: "SUPERSEDED" };
}

// 未対応のフラグから導出するタグ。例: LATE_PAYMENT → btc-review-late-payment
export function reviewTag(reason: ReviewReason): string {
  return `btc-review-${reason.toLowerCase().replaceAll("_", "-")}`;
}

// 支払い済みの注文には orderMarkAsPaid を呼ばない。先に displayFinancialStatus を確かめる
async function markAsPaid(shopify: ShopifyGateway, shopifyOrderId: string): Promise<void> {
  const order = await shopify.getOrder(shopifyOrderId);
  if (!order) throw new Error(`Shopify の注文 ${shopifyOrderId} がない`);
  if (order.financialStatus === "PAID") return;
  await shopify.markOrderAsPaid(shopifyOrderId);
}
