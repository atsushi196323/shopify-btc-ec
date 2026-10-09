// BtcpayGateway を BTCPay Server の Greenfield API で実装する。
import {
  ForeignInvoiceError,
  type BtcpayGateway,
  type BtcpayInvoice,
  type CreateInvoiceInput,
} from "../../application/ports/btcpay-gateway";
import { toObservation } from "./invoice-observation";

export type GreenfieldConfig = {
  baseUrl: string;
  apiKey: string;
  storeId: string;
  // 1回の呼び出しの上限。超えたら例外にして、呼び出し側（スイープ・inbox の再処理）に任せる
  timeoutMs?: number;
};

// Greenfield の invoice のうち、使う項目だけ
type GreenfieldInvoice = {
  id: string;
  status: string;
  additionalStatus: string;
  checkoutLink: string;
  metadata?: { orderId?: string };
};

export class BtcpayApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "BtcpayApiError";
  }
}

export class GreenfieldClient implements BtcpayGateway {
  private readonly baseUrl: string;

  constructor(private readonly config: GreenfieldConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  async createInvoice(input: CreateInvoiceInput): Promise<BtcpayInvoice> {
    const invoice = await this.request<GreenfieldInvoice>("POST", this.storePath("/invoices"), {
      amount: input.amount,
      currency: input.currency,
      // metadata.orderId が BTCPay の orderId 欄になる。ここには attemptId を入れる（ADR 5）
      metadata: { orderId: input.attemptId, shopifyOrderId: input.shopifyOrderId },
    });
    return toBtcpayInvoice(invoice);
  }

  async getInvoice(invoiceId: string): Promise<BtcpayInvoice> {
    const invoice = await this.request<GreenfieldInvoice>(
      "GET",
      this.storePath(`/invoices/${encodeURIComponent(invoiceId)}`),
    );
    return toBtcpayInvoice(invoice);
  }

  async findInvoicesByAttemptId(attemptId: string): Promise<BtcpayInvoice[]> {
    // アーカイブした invoice は既定では返らない。見落とすと孤児の回復が二重に作るので含める
    const query = new URLSearchParams({ orderId: attemptId, includeArchived: "true" });
    const invoices = await this.request<GreenfieldInvoice[]>("GET", this.storePath(`/invoices?${query}`));
    // 検索は BTCPay 側の実装に任せず、orderId が完全に一致するものだけを返す
    return invoices.filter((invoice) => invoice.metadata?.orderId === attemptId).map(toBtcpayInvoice);
  }

  private storePath(path: string): string {
    return `/api/v1/stores/${encodeURIComponent(this.config.storeId)}${path}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `token ${this.config.apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new BtcpayApiError(response.status, text, `BTCPay ${method} ${path} が ${response.status} を返した`);
    }
    return JSON.parse(text) as T;
  }
}

function toBtcpayInvoice(invoice: GreenfieldInvoice): BtcpayInvoice {
  const attemptId = invoice.metadata?.orderId;
  // このアプリが作った invoice には必ず orderId がある。ない invoice は試行に結びつけられない
  if (!attemptId) throw new ForeignInvoiceError(invoice.id);
  return {
    invoiceId: invoice.id,
    attemptId,
    checkoutLink: invoice.checkoutLink,
    observation: toObservation(invoice.status, invoice.additionalStatus),
  };
}
