// BTCPay とのやり取りのポート（ADR 3）。アダプタは src/adapters/btcpay/ にある。
// テストでは、このインターフェースを包むデコレータで遅延や例外を注入する（ADR 10）。
import type { InvoiceObservation } from "../../domain/payment";

export type CreateInvoiceInput = {
  // BTCPay の invoice の orderId 欄に入れる、試行単位の冪等性キー（ADR 5）
  attemptId: string;
  // メタデータに入れる。BTCPay の orderId 欄には入れない（design.md 3章の命名の約束）
  shopifyOrderId: string;
  // 10進数の文字列（例: "1000"）。請求額はサーバー側で Shopify から取り直したもの（ADR 4）
  amount: string;
  currency: string;
};

export type BtcpayInvoice = {
  invoiceId: string;
  // 試行の id。BTCPay の orderId 欄から読む
  attemptId: string;
  checkoutLink: string;
  observation: InvoiceObservation;
};

export interface BtcpayGateway {
  createInvoice(input: CreateInvoiceInput): Promise<BtcpayInvoice>;
  getInvoice(invoiceId: string): Promise<BtcpayInvoice>;
  // 孤児の回復で使う（ADR 5）。通常は0件か1件。複数あったときの扱いは呼び出し側が決める
  findInvoicesByAttemptId(attemptId: string): Promise<BtcpayInvoice[]>;
}
