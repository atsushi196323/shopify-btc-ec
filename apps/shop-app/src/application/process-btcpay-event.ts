// BTCPay の Webhook のワーカー（design.md 5.3 の 3・4、ADR 8）。inbox の1行を処理する。
// ペイロードは信用せず、invoice の最新状態を Greenfield から取り直し、遷移とフラグはドメインで判定する。
// 判定の結果は version 付きで保存し、競合したら DB を読み直して再判定する（Greenfield の再取得はしない）。
import { applyObservation } from "../domain/payment";
import { ForeignInvoiceError, type BtcpayGateway } from "./ports/btcpay-gateway";
import type { InboxRepository } from "./ports/inbox-repository";
import type { PaymentRepository } from "./ports/payment-repository";
import { invalidateAttempt, type InvalidateResult } from "./invalidate-attempt";
import { MAX_CONFLICT_RETRIES } from "./retry-limits";
import { syncPaymentToShopify, type ShopifySyncDeps, type ShopifySyncResult } from "./sync-to-shopify";

// inbox の1行を再処理する合計回数の上限。超えたら FAILED にして、人が気づけるようにする（design.md 5.3 の 3-5）
export const MAX_INBOX_ATTEMPTS = 10;

export type ProcessEventDeps = {
  payments: PaymentRepository;
  inbox: InboxRepository;
  btcpay: BtcpayGateway;
};

// APPLIED: 試行・状態・フラグのどれかを保存した / NO_CHANGE: 判定の結果、変わるものがなかった
// IGNORED: このアプリの試行に紐づかない invoice（orderId 欄がない・試行に当たらない invoice、紐づけに負けた invoice。ADR 5）
// ALREADY_PROCESSED: inbox の行が PENDING でない / RETRY: PENDING のまま残した / FAILED: 回数の上限に達した
export type ProcessEventResult =
  | { outcome: "APPLIED"; paymentId: string; needsShopifySync: boolean; attemptToInvalidate: string | null }
  | { outcome: "NO_CHANGE" | "IGNORED" | "ALREADY_PROCESSED" | "RETRY" | "FAILED" };

export type HandleEventDeps = ProcessEventDeps & ShopifySyncDeps;
// 保存の後に行う外部呼び出しの結果。呼ばなかったら null
export type HandleEventResult = {
  event: ProcessEventResult;
  invalidation: InvalidateResult | { outcome: "FAILED"; error: string } | null;
  sync: ShopifySyncResult | null;
};

// ワーカーの1件分。保存の commit の直後に、無効化（ADR 9）と Shopify への反映（design.md 5.3 の 4）を1回ずつ呼ぶ。
// どちらも失敗したらスイープが追いつかせる。外部呼び出しの例外は、保存済みのイベントの結果と分けて返す
export async function handleBtcpayEvent(deps: HandleEventDeps, inboxId: string): Promise<HandleEventResult> {
  const event = await processBtcpayEvent(deps, inboxId);
  if (event.outcome !== "APPLIED") return { event, invalidation: null, sync: null };
  const invalidation = event.attemptToInvalidate
    ? await settle(() => invalidateAttempt(deps, event.attemptToInvalidate!))
    : null;
  const sync = event.needsShopifySync ? await settle(() => syncPaymentToShopify(deps, event.paymentId)) : null;
  return { event, invalidation, sync };
}

async function settle<T>(call: () => Promise<T>): Promise<T | { outcome: "FAILED"; error: string }> {
  try {
    return await call();
  } catch (error) {
    return { outcome: "FAILED", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function processBtcpayEvent(deps: ProcessEventDeps, inboxId: string): Promise<ProcessEventResult> {
  const event = await deps.inbox.find(inboxId);
  if (!event || event.status !== "PENDING") return { outcome: "ALREADY_PROCESSED" };

  // 失敗の記録は try の外で行う。記録自体が失敗したときに、catch がもう一度記録しないようにする
  let failure: string;
  try {
    const processed = await apply(deps, inboxId, event.invoiceId);
    if (processed) return processed;
    failure = `version の競合が ${MAX_CONFLICT_RETRIES} 回続いた`;
  } catch (error) {
    if (error instanceof ForeignInvoiceError) {
      await deps.inbox.markDone(inboxId);
      return { outcome: "IGNORED" };
    }
    failure = error instanceof Error ? error.message : String(error);
  }
  // PENDING のまま残し、次回のワーカーかスイープに任せる（design.md 5.3 の 3-4）
  const status = await deps.inbox.recordFailure(inboxId, failure, MAX_INBOX_ATTEMPTS);
  switch (status) {
    case "PENDING":
      return { outcome: "RETRY" };
    case "FAILED":
      return { outcome: "FAILED" };
    case "DONE":
      // 並行した別の処理が先に DONE にした
      return { outcome: "ALREADY_PROCESSED" };
  }
}

// 判定して保存する。version の競合が上限まで続いたら null
async function apply(deps: ProcessEventDeps, inboxId: string, invoiceId: string): Promise<ProcessEventResult | null> {
  // トランザクションの外で取り直す。古い状態を取っても、試行は前にしか進まないので害はない（ADR 8 の決定2）
  const invoice = await deps.btcpay.getInvoice(invoiceId);

  for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
    const loaded = await deps.payments.loadForAttempt(invoice.attemptId);
    if (!loaded || (loaded.btcpayInvoiceId !== null && loaded.btcpayInvoiceId !== invoice.invoiceId)) {
      await deps.inbox.markDone(inboxId);
      return { outcome: "IGNORED" };
    }
    // 作成の直後に届いたイベント。紐づけ（作成した呼び出しか、スイープの孤児回復）が済んでから処理する
    if (loaded.btcpayInvoiceId === null) {
      throw new Error(`試行 ${invoice.attemptId} に invoice がまだ紐づいていない`);
    }

    const result = applyObservation(loaded.state, invoice.attemptId, invoice.observation);
    if (!result.attemptChanged && !result.needsShopifySync) {
      await deps.inbox.markDone(inboxId);
      return { outcome: "NO_CHANGE" };
    }
    const { saved } = await deps.payments.saveObservation({
      paymentId: loaded.paymentId,
      expectedVersion: loaded.version,
      attemptId: invoice.attemptId,
      result,
      inboxId,
    });
    // 無効化（attemptToInvalidate）と Shopify への反映は、commit の後に呼び出し側（handleBtcpayEvent）が行う
    if (saved) {
      return {
        outcome: "APPLIED",
        paymentId: loaded.paymentId,
        needsShopifySync: result.needsShopifySync,
        attemptToInvalidate: result.attemptToInvalidate,
      };
    }
  }
  return null;
}
