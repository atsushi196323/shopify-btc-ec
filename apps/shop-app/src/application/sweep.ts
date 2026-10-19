// スイープ（design.md 5.5）。1本のジョブで、Webhook の取りこぼしや外部呼び出しの失敗を追いつかせる。
// どの段も冪等な処理を呼び直すだけなので、ワーカーと並行に動いても、何度回しても同じ結果に収束する（ADR 8）。
// 段の順番には意味がある。前の段で保存した変更（照合で UNRESOLVED になったなど）を、同じ回の後の段（無効化・反映）が拾う
import { recoverCreatingAttempt } from "./create-invoice";
import { invalidateAttempt } from "./invalidate-attempt";
import { handleBtcpayEvent, reconcileInvoice, type HandleEventDeps } from "./process-btcpay-event";
import type { ShopifyGateway } from "./ports/shopify-gateway";
import { syncPaymentToShopify } from "./sync-to-shopify";

export type SweepDeps = HandleEventDeps & { now?: () => Date };

export type SweepSettings = {
  // CREATING のまま、これより長く経った試行を孤児とみなす。BTCPay の呼び出しの上限（10秒）より十分長く取り、
  // 作成中の呼び出しとスイープの作り直しが重なって、同じ試行に invoice が2つできるのを避ける（ADR 5）
  orphanAfterMs: number;
  // 自分で無効化した試行を、無効化からこの期間だけ照合する（ADR 9）。BTCPay が入金を拾う期間（ストアの invoiceExpiration 180秒
  // + monitoringExpiration 300秒。作成から数える）より長く取る。ストアの設定を延ばしたら、ここも延ばす
  invalidatedWatchMs: number;
  // EXPIRED の試行を、期限切れを記録してからこの期間だけ照合する。EXPIRED は終端だが、BTCPay は期限後も monitoringExpiration（300秒）の間は
  // 入金を拾うので、その Webhook を取りこぼすと期限後の入金（LATE_PAYMENT）を見逃す。monitoringExpiration より長く取る
  expiredWatchMs: number;
  // inbox の行は、受信か最後の失敗からこれより長く経ったものだけを再処理する。受信の直後にワーカーが処理している行と重なって、
  // 失敗の回数を二重に数えないようにする
  inboxRetryAfterMs: number;
};

export const DEFAULT_SWEEP_SETTINGS: SweepSettings = {
  orphanAfterMs: 60_000,
  invalidatedWatchMs: 600_000,
  expiredWatchMs: 600_000,
  inboxRetryAfterMs: 30_000,
};

// 1件分の結果。outcome は各段で呼んだ処理の結果、例外なら ERROR
export type SweepItem = { id: string; outcome: string; error?: string };

export type SweepReport = {
  orphans: SweepItem[];
  reconciled: SweepItem[];
  invalidated: SweepItem[];
  watched: SweepItem[];
  inbox: SweepItem[];
  synced: SweepItem[];
};

export async function runSweep(deps: SweepDeps, settings: SweepSettings = DEFAULT_SWEEP_SETTINGS): Promise<SweepReport> {
  const now = (deps.now ?? (() => new Date()))();

  // 1. 孤児の回復。注文を確かめ直すので、試行の Payment のショップで Shopify を呼ぶ
  const orphanTargets = await deps.payments.findOrphanAttempts(new Date(now.getTime() - settings.orphanAfterMs));
  // 取得できたゲートウェイだけを回の中で使い回す。失敗は覚えず、同じショップの次の試行で取り直す
  const shopify = new Map<string, ShopifyGateway>();
  const orphans = await each(orphanTargets, (o) => o.attemptId, async ({ attemptId, shop }) => {
    if (!shopify.has(shop)) shopify.set(shop, await deps.shopifyFor(shop));
    const invoiceDeps = { shop, payments: deps.payments, btcpay: deps.btcpay, shopify: shopify.get(shop)! };
    return recoverCreatingAttempt(invoiceDeps, attemptId);
  });

  // 2. 照合。終端でない試行と、監視期間の間の EXPIRED の試行の状態を取り直す。
  // 期限後の入金で UNRESOLVED になったら、同じ回の無効化（3）が再発行した新しい invoice を無効化する
  const unsettled = [
    ...(await deps.payments.findUnsettledInvoices()),
    ...(await deps.payments.findExpiredInvoices(new Date(now.getTime() - settings.expiredWatchMs))),
  ];
  const reconciled = await each(unsettled, (i) => i.btcpayInvoiceId, (i) => reconcileInvoice(deps, i.btcpayInvoiceId));

  // 3. 無効化のリトライ
  const toInvalidate = await deps.payments.findAttemptsToInvalidate();
  const invalidated = await each(toInvalidate, (id) => id, (id) => invalidateAttempt(deps, id));

  // 4. 無効化した試行の監視。入金があれば、照合の判定で DOUBLE_PAYMENT が付く
  const recent = await deps.payments.findInvalidatedInvoices(new Date(now.getTime() - settings.invalidatedWatchMs));
  const watched = await each(recent, (i) => i.btcpayInvoiceId, (i) => reconcileInvoice(deps, i.btcpayInvoiceId));

  // 5. inbox の再処理。ワーカーと同じく、保存の後に無効化と反映も1回ずつ呼ぶ
  const pending = await deps.inbox.findPending(new Date(now.getTime() - settings.inboxRetryAfterMs));
  const inbox = await each(pending, (id) => id, async (id) => (await handleBtcpayEvent(deps, id)).event);

  // 6. Shopify への反映
  const pendingSync = await deps.payments.findPendingSync();
  const synced = await each(pendingSync, (id) => id, (id) => syncPaymentToShopify(deps, id));

  return { orphans, reconciled, invalidated, watched, inbox, synced };
}

// 1件ずつ順に処理する。1件の失敗で残りを止めず、次の回のスイープに任せる
async function each<T>(
  targets: T[],
  idOf: (target: T) => string,
  run: (target: T) => Promise<{ outcome: string }>,
): Promise<SweepItem[]> {
  const items: SweepItem[] = [];
  for (const target of targets) {
    const id = idOf(target);
    try {
      items.push({ id, outcome: (await run(target)).outcome });
    } catch (error) {
      items.push({ id, outcome: "ERROR", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return items;
}
