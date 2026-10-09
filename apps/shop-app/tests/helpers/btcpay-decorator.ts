import type { BtcpayGateway, BtcpayInvoice, CreateInvoiceInput } from "../../src/application/ports/btcpay-gateway";

// 統合テスト用に BtcpayGateway を包み、遅延をテスト側から注入するデコレータ（ADR 10）。
// 本物の呼び出しはそのまま中のゲートウェイに渡すので、本番コードにテスト用の分岐は入らない。
// 例外の注入（作成を委譲した後に失敗を返す）は、シナリオ8（W4）で加える
export class InjectingBtcpayGateway implements BtcpayGateway {
  // 中のゲートウェイに委譲した createInvoice の入力。BTCPay に作成を頼んだ回数を数える
  readonly createCalls: CreateInvoiceInput[] = [];
  // createInvoice を委譲する直前に待つ。競合が起きる時間帯を広げる
  beforeCreate: (input: CreateInvoiceInput) => Promise<void> = async () => {};

  constructor(private readonly inner: BtcpayGateway) {}

  async createInvoice(input: CreateInvoiceInput): Promise<BtcpayInvoice> {
    await this.beforeCreate(input);
    this.createCalls.push(input);
    return this.inner.createInvoice(input);
  }

  getInvoice(invoiceId: string): Promise<BtcpayInvoice> {
    return this.inner.getInvoice(invoiceId);
  }

  findInvoicesByAttemptId(attemptId: string): Promise<BtcpayInvoice[]> {
    return this.inner.findInvoicesByAttemptId(attemptId);
  }
}

export const delay = (ms: number) => () => new Promise<void>((resolve) => setTimeout(resolve, ms));
