import type { BtcpayGateway, BtcpayInvoice, CreateInvoiceInput } from "../../src/application/ports/btcpay-gateway";

// 統合テスト用に BtcpayGateway を包み、遅延や例外をテスト側から注入するデコレータ（ADR 10）。
// 本物の呼び出しはそのまま中のゲートウェイに渡すので、本番コードにテスト用の分岐は入らない。
export class InjectingBtcpayGateway implements BtcpayGateway {
  // 中のゲートウェイに委譲した createInvoice の入力。BTCPay に作成を頼んだ回数を数える
  readonly createCalls: CreateInvoiceInput[] = [];
  // createInvoice を委譲する直前に待つ。競合が起きる時間帯を広げる
  beforeCreate: (input: CreateInvoiceInput) => Promise<void> = async () => {};
  // createInvoice を委譲して BTCPay で作られた後に呼ぶ。例外を投げると、作成の後・DB の更新の前に落ちたことになる（シナリオ8）
  afterCreate: (invoice: BtcpayInvoice) => Promise<void> = async () => {};

  constructor(private readonly inner: BtcpayGateway) {}

  async createInvoice(input: CreateInvoiceInput): Promise<BtcpayInvoice> {
    await this.beforeCreate(input);
    this.createCalls.push(input);
    const invoice = await this.inner.createInvoice(input);
    await this.afterCreate(invoice);
    return invoice;
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

// 1回だけ例外を投げ、その後は何もしない
export function failOnce(message: string): () => Promise<void> {
  let failed = false;
  return async () => {
    if (failed) return;
    failed = true;
    throw new Error(message);
  };
}

export const delay = (ms: number) => () => new Promise<void>((resolve) => setTimeout(resolve, ms));
