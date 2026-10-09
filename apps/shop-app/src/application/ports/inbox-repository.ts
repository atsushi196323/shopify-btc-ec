// 受信した Webhook の保存のポート（ADR 3・8）。アダプタは src/adapters/db/ にある。

// 署名を検証した BTCPay のイベント。ワーカーは invoice の状態を Greenfield から取り直すので、使うのは invoice ID だけ
export type BtcpayEventInput = { eventId: string; type: string; invoiceId: string };

export type InboxStatus = "PENDING" | "DONE" | "FAILED";

export type InboxEvent = { inboxId: string; status: InboxStatus; invoiceId: string; attempts: number };

export interface InboxRepository {
  // duplicate: true は、同じ eventId の行がすでにあった（返すのはその行の id）。重複の除去は最適化にすぎない（ADR 8 の決定1）
  saveBtcpayEvent(event: BtcpayEventInput): Promise<{ inboxId: string; duplicate: boolean }>;
  find(inboxId: string): Promise<InboxEvent | null>;
  markDone(inboxId: string): Promise<void>;
  // 再処理の回数を1つ増やし、エラーを記録する。合計が maxAttempts に達したら FAILED にする。戻り値は記録した後の状態
  recordFailure(inboxId: string, error: string, maxAttempts: number): Promise<InboxStatus>;
}
