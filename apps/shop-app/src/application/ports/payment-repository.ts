// Payment と試行の保存のポート（ADR 3）。アダプタは src/adapters/db/ にある。
// 遷移とフラグの判定は domain と application が行い、リポジトリはロックと保存だけを受け持つ。
import type { InvoiceAttemptStatus } from "../../domain/invoice-attempt";
import type { ObservationResult, PaymentState, PaymentStatus } from "../../domain/payment";
import type { ReviewReason } from "../../domain/review-flag";

export type PaymentSnapshot = {
  paymentId: string;
  // 注文のショップ。拡張から届いた注文が、セッションのショップのものかを確かめるのにも使う
  shop: string;
  shopifyOrderId: string;
  status: PaymentStatus;
  version: number;
  currentAttempt: { id: string; status: InvoiceAttemptStatus; btcpayInvoiceId: string | null };
};

export type AttemptSnapshot = {
  attemptId: string;
  paymentId: string;
  shopifyOrderId: string;
  status: InvoiceAttemptStatus;
  btcpayInvoiceId: string | null;
};

// shop は注文のショップ（xxx.myshopify.com）。Shopify への反映で、このショップのオフラインセッションを使う
export type ReserveInput = { paymentId: string; attemptId: string; shop: string; shopifyOrderId: string };

// reserved: false は、同じ shopifyOrderId の Payment がすでにあった（UNIQUE に負けた）ことを表す
export type ReserveResult = { reserved: boolean; payment: PaymentSnapshot };

export type AttachInvoiceInput = {
  attemptId: string;
  btcpayInvoiceId: string;
  // 紐づけた時点の Payment の様子から、次の状態とフラグを決める。ロックを取った後に呼ばれる
  decide: (state: PaymentState) => ObservationResult;
};

// attached: false は、試行がすでに CREATING でない（別の処理が先に紐づけた）ことを表す
// attemptToInvalidate は、紐づけた結果、無効化すべきになった試行（ドメインの判定。紐づけなかったら null）
export type AttachInvoiceResult = { attached: boolean; payment: PaymentSnapshot; attemptToInvalidate: string | null };

// ワーカーが判定に使う、試行の Payment の現在の様子（design.md 5.3 の 3）
export type PaymentForAttempt = {
  paymentId: string;
  // 楽観ロック用。保存のときに、読んだときから変わっていないことを確かめる（ADR 6 の直列化）
  version: number;
  state: PaymentState;
  // この試行に紐づいた invoice。CREATING の間は null
  btcpayInvoiceId: string | null;
};

export type SaveObservationInput = {
  paymentId: string;
  expectedVersion: number;
  attemptId: string;
  result: ObservationResult;
  // 同じ commit で DONE にする inbox の行（ADR 8 の決定4）。スイープの照合（inbox を通さない）では null
  inboxId: string | null;
};

// 判定と保存の間に別の処理が更新していないことを、version で確かめる書き込みの共通の入力
type VersionedWrite = { paymentId: string; expectedVersion: number };

export type MarkInvalidatedInput = VersionedWrite & { attemptId: string };

// 再発行（design.md 5.4）。state はドメインの reissue() の結果。保存するのは、reissue() が変えるものだけ:
// status、新しい試行（state の現在の試行。まだ DB にないこと）、ポインタ。ほかの試行とフラグは変わらない
export type SaveReissueInput = VersionedWrite & { state: PaymentState };

// Shopify への反映（design.md 4章「Shopify への反映」）に使う、Payment の現在の様子
export type PaymentForSync = {
  paymentId: string;
  shop: string;
  shopifyOrderId: string;
  status: PaymentStatus;
  // 反映が終わったら、この version のままのときだけ DONE にする
  version: number;
  shopifySync: "PENDING" | "DONE";
  // 未対応（resolvedAt なし）のフラグの理由。重複は除く
  unresolvedReasons: ReviewReason[];
};

// スイープの孤児回復（design.md 5.5 の 1）の対象。shop は回復で注文を確かめ直すときに使う
export type OrphanAttempt = { attemptId: string; shop: string };

// スイープの照合（design.md 5.5 の 2・4）の対象
export type InvoiceToReconcile = { attemptId: string; btcpayInvoiceId: string };

export interface PaymentRepository {
  findByShopifyOrderId(shopifyOrderId: string): Promise<PaymentSnapshot | null>;
  findAttempt(attemptId: string): Promise<AttemptSnapshot | null>;
  // Payment（ポインタは NULL）→ 試行（CREATING）→ ポインタの設定を、1つのトランザクションで行う（design.md 3章、ADR 5・7）
  reserve(input: ReserveInput): Promise<ReserveResult>;
  // CREATING の試行に BTCPay の invoice を紐づけ、decide の結果を保存する
  attachInvoice(input: AttachInvoiceInput): Promise<AttachInvoiceResult>;
  loadForAttempt(attemptId: string): Promise<PaymentForAttempt | null>;
  // 判定の結果を version 付きで保存する。saved: false は、読んだ後に別の処理が先に更新した（version が変わっていた）ことを表す
  saveObservation(input: SaveObservationInput): Promise<{ saved: boolean }>;
  // 無効化の意図（invalidatedByUs・invalidatedAt）を記録する。BTCPay を呼ぶ前に行う（ADR 9）。false は version の競合
  markInvalidatedByUs(input: MarkInvalidatedInput): Promise<boolean>;
  // saved: false は version の競合
  saveReissue(input: SaveReissueInput): Promise<{ saved: boolean; payment: PaymentSnapshot }>;
  loadForSync(paymentId: string): Promise<PaymentForSync | null>;
  // 読んだときの version のまま PENDING なら DONE にし、shopifySyncError を消す。false は、反映中に別の変更が入った（PENDING のまま）
  markSynced(paymentId: string, version: number): Promise<boolean>;
  // 反映の失敗を記録する。PENDING のまま残し、スイープに任せる。別の処理が先に DONE にしていたら何もしない
  recordSyncError(paymentId: string, error: string): Promise<void>;

  // 以下はスイープ（design.md 5.5）が対象を探すクエリ。古いものから返す
  // CREATING のまま（invoice が紐づかないまま）createdBefore まで（その時刻を含む）に作られた試行
  findOrphanAttempts(createdBefore: Date): Promise<OrphanAttempt[]>;
  // 終端でない（NEW・PROCESSING の）、invoice が紐づいた試行
  findUnsettledInvoices(): Promise<InvoiceToReconcile[]>;
  // Payment が UNRESOLVED なのに、現在の試行が NEW のまま（無効化が済んでいない）の試行の id
  findAttemptsToInvalidate(): Promise<string[]>;
  // invalidatedSince 以降に、自分で無効化した試行（ADR 9 の監視期間）
  findInvalidatedInvoices(invalidatedSince: Date): Promise<InvoiceToReconcile[]>;
  // shopifySync = PENDING の Payment の id
  findPendingSync(): Promise<string[]>;
}
