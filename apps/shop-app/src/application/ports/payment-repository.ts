// Payment と試行の保存のポート（ADR 3）。アダプタは src/adapters/db/ にある。
// 遷移とフラグの判定は domain と application が行い、リポジトリはロックと保存だけを受け持つ。
import type { InvoiceAttemptStatus } from "../../domain/invoice-attempt";
import type { ObservationResult, PaymentState, PaymentStatus } from "../../domain/payment";

export type PaymentSnapshot = {
  paymentId: string;
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

export type ReserveInput = { paymentId: string; attemptId: string; shopifyOrderId: string };

// reserved: false は、同じ shopifyOrderId の Payment がすでにあった（UNIQUE に負けた）ことを表す
export type ReserveResult = { reserved: boolean; payment: PaymentSnapshot };

export type AttachInvoiceInput = {
  attemptId: string;
  btcpayInvoiceId: string;
  // 紐づけた時点の Payment の様子から、次の状態とフラグを決める。ロックを取った後に呼ばれる
  decide: (state: PaymentState) => ObservationResult;
};

// attached: false は、試行がすでに CREATING でない（別の処理が先に紐づけた）ことを表す
export type AttachInvoiceResult = { attached: boolean; payment: PaymentSnapshot };

export interface PaymentRepository {
  findByShopifyOrderId(shopifyOrderId: string): Promise<PaymentSnapshot | null>;
  findAttempt(attemptId: string): Promise<AttemptSnapshot | null>;
  // Payment（ポインタは NULL）→ 試行（CREATING）→ ポインタの設定を、1つのトランザクションで行う（design.md 3章、ADR 5・7）
  reserve(input: ReserveInput): Promise<ReserveResult>;
  // CREATING の試行に BTCPay の invoice を紐づけ、decide の結果を保存する
  attachInvoice(input: AttachInvoiceInput): Promise<AttachInvoiceResult>;
}
