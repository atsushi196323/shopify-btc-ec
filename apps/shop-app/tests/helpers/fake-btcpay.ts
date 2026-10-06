import { randomUUID } from "node:crypto";
import type { BtcpayGateway, BtcpayInvoice, CreateInvoiceInput } from "../../src/application/ports/btcpay-gateway";
import type { InvoiceObservation } from "../../src/domain/payment";

// application のテスト用の BtcpayGateway。invoice をメモリに持つ。
// 本物の BTCPay に対する約束は tests/integration/btcpay/ で確かめる
export class FakeBtcpayGateway implements BtcpayGateway {
  readonly created: (CreateInvoiceInput & { invoiceId: string })[] = [];
  private readonly invoices = new Map<string, BtcpayInvoice>();
  // 次の createInvoice の前に呼ぶ。例外を投げると、作成が失敗したことになる
  beforeCreate: (input: CreateInvoiceInput) => Promise<void> | void = () => {};

  async createInvoice(input: CreateInvoiceInput): Promise<BtcpayInvoice> {
    await this.beforeCreate(input);
    const invoiceId = randomUUID();
    this.created.push({ ...input, invoiceId });
    const invoice: BtcpayInvoice = {
      invoiceId,
      attemptId: input.attemptId,
      checkoutLink: `http://btcpay.test/i/${invoiceId}`,
      observation: { status: "NEW", received: "NONE" },
    };
    this.invoices.set(invoiceId, invoice);
    return structuredClone(invoice);
  }

  async getInvoice(invoiceId: string): Promise<BtcpayInvoice> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new Error(`invoice ${invoiceId} がない`);
    return structuredClone(invoice);
  }

  async findInvoicesByAttemptId(attemptId: string): Promise<BtcpayInvoice[]> {
    return [...this.invoices.values()].filter((invoice) => invoice.attemptId === attemptId).map((i) => structuredClone(i));
  }

  setObservation(invoiceId: string, observation: InvoiceObservation): void {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new Error(`invoice ${invoiceId} がない`);
    invoice.observation = observation;
  }
}
