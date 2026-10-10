import type { GreenfieldConfig } from "../../src/adapters/btcpay/greenfield-client";
import type { BtcpayGateway, BtcpayInvoice, CreateInvoiceInput } from "../../src/application/ports/btcpay-gateway";

// 統合テスト用に BtcpayGateway を包み、期限が1分の invoice を作るデコレータ（ADR 10）。
// ストアの期限（bootstrap.sh の invoiceExpiration = 180秒）を待たずに、期限切れのシナリオ（2・3・9）を確かめる。
// 作成だけを Greenfield に直接頼み、metadata はアダプタと同じ形にする。ほかの呼び出しは中のゲートウェイに渡す
export class ShortExpiryBtcpayGateway implements BtcpayGateway {
  constructor(
    private readonly inner: BtcpayGateway,
    private readonly config: GreenfieldConfig,
  ) {}

  async createInvoice(input: CreateInvoiceInput): Promise<BtcpayInvoice> {
    const response = await fetch(`${this.config.baseUrl}/api/v1/stores/${this.config.storeId}/invoices`, {
      method: "POST",
      headers: { Authorization: `token ${this.config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: input.amount,
        currency: input.currency,
        metadata: { orderId: input.attemptId, shopifyOrderId: input.shopifyOrderId },
        // BTCPay が受け付ける最小の期限（1分未満は Invalid timespan になる）
        checkout: { expirationMinutes: 1 },
      }),
    });
    if (!response.ok) throw new Error(`invoice の作成: ${response.status} ${await response.text()}`);
    const { id } = (await response.json()) as { id: string };
    return this.inner.getInvoice(id);
  }

  getInvoice(invoiceId: string): Promise<BtcpayInvoice> {
    return this.inner.getInvoice(invoiceId);
  }

  findInvoicesByAttemptId(attemptId: string): Promise<BtcpayInvoice[]> {
    return this.inner.findInvoicesByAttemptId(attemptId);
  }

  invalidateInvoice(invoiceId: string): Promise<void> {
    return this.inner.invalidateInvoice(invoiceId);
  }
}
