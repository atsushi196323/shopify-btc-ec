import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { BtcpayInvoice } from "../../../src/application/ports/btcpay-gateway";
import { BtcpayApiError, GreenfieldClient, type GreenfieldConfig } from "../../../src/adapters/btcpay/greenfield-client";
import { ForeignInvoiceError } from "../../../src/application/ports/btcpay-gateway";
import { btcpayConfig, mineBlocks, pay } from "../../helpers/regtest";

// 本物の BTCPay（regtest）に対して、GreenfieldClient が BtcpayGateway の約束どおりに動くことを確かめる。
// 固定レートは BTC_JPY = 10000000（1円 = 10 sat、ADR 10）
describe("GreenfieldClient（regtest）", () => {
  let config: GreenfieldConfig;
  let client: GreenfieldClient;

  beforeAll(() => {
    config = btcpayConfig();
    client = new GreenfieldClient(config);
  });

  const create = (amount = "1000") =>
    client.createInvoice({ attemptId: randomUUID(), shopifyOrderId: `gid://shopify/Order/${Date.now()}`, amount, currency: "JPY" });

  it("invoice を作ると NEW・入金なしで、orderId 欄に attemptId が入る", async () => {
    const attemptId = randomUUID();
    const invoice = await client.createInvoice({
      attemptId,
      shopifyOrderId: "gid://shopify/Order/1",
      amount: "1000",
      currency: "JPY",
    });

    expect(invoice.attemptId).toBe(attemptId);
    expect(invoice.observation).toEqual({ status: "NEW", received: "NONE" });
    expect(invoice.checkoutLink).toContain(invoice.invoiceId);

    const metadata = await greenfield<{ metadata: Record<string, unknown> }>(`/invoices/${invoice.invoiceId}`);
    expect(metadata.metadata).toMatchObject({ orderId: attemptId, shopifyOrderId: "gid://shopify/Order/1" });
  });

  it("getInvoice は作成した invoice を返す", async () => {
    const created = await create();

    expect(await client.getInvoice(created.invoiceId)).toEqual(created);
  });

  it("findInvoicesByAttemptId は、その試行の invoice だけを返す", async () => {
    const target = await create();
    await create();

    const found = await client.findInvoicesByAttemptId(target.attemptId);

    expect(found.map((invoice) => invoice.invoiceId)).toEqual([target.invoiceId]);
  });

  it("findInvoicesByAttemptId は、アーカイブした invoice も返す", async () => {
    const target = await create();
    // Greenfield の DELETE は invoice をアーカイブする（消えはしない）
    const response = await fetch(`${config.baseUrl}/api/v1/stores/${config.storeId}/invoices/${target.invoiceId}`, {
      method: "DELETE",
      headers: { Authorization: `token ${config.apiKey}` },
    });
    expect(response.ok).toBe(true);

    const found = await client.findInvoicesByAttemptId(target.attemptId);

    expect(found.map((invoice) => invoice.invoiceId)).toEqual([target.invoiceId]);
  });

  it("findInvoicesByAttemptId は、invoice がなければ空を返す", async () => {
    expect(await client.findInvoicesByAttemptId(randomUUID())).toEqual([]);
  });

  // BTCPay 2.4 は、ストアにない invoice を 404 ではなく 403 で返す（権限の検査で弾かれる）
  it("存在しない invoice の取得は BtcpayApiError（403）になる", async () => {
    const error = await client.getInvoice("does-not-exist").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BtcpayApiError);
    expect((error as BtcpayApiError).status).toBe(403);
  });

  it("orderId 欄のない invoice の取得は ForeignInvoiceError になる", async () => {
    // BTCPay の管理画面で手で作った invoice と同じく、orderId を入れずに作る
    const response = await fetch(`${config.baseUrl}/api/v1/stores/${config.storeId}/invoices`, {
      method: "POST",
      headers: { Authorization: `token ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: "1000", currency: "JPY" }),
    });
    const { id } = (await response.json()) as { id: string };

    const error = await client.getInvoice(id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForeignInvoiceError);
  });

  it("全額を払うと PROCESSING・FULL、1ブロックで SETTLED・FULL になる", async () => {
    const invoice = await create();
    const { destination, due } = await paymentMethod(invoice.invoiceId);

    pay(destination, due);
    expect(await waitFor(invoice.invoiceId, (i) => i.observation.status === "PROCESSING")).toMatchObject({
      observation: { status: "PROCESSING", received: "FULL" },
    });

    mineBlocks(1);
    expect(await waitFor(invoice.invoiceId, (i) => i.observation.status === "SETTLED")).toMatchObject({
      observation: { status: "SETTLED", received: "FULL" },
    });
  });

  it("過払いは PROCESSING・OVER になる", async () => {
    const invoice = await create();
    const { destination, due } = await paymentMethod(invoice.invoiceId);

    pay(destination, (Number(due) * 2).toFixed(8));

    expect(await waitFor(invoice.invoiceId, (i) => i.observation.status === "PROCESSING")).toMatchObject({
      observation: { status: "PROCESSING", received: "OVER" },
    });
  });

  it("一部だけ払うと NEW・PARTIAL になる", async () => {
    const invoice = await create();
    const { destination, due } = await paymentMethod(invoice.invoiceId);

    pay(destination, (Number(due) / 2).toFixed(8));

    expect(await waitFor(invoice.invoiceId, (i) => i.observation.received !== "NONE")).toMatchObject({
      observation: { status: "NEW", received: "PARTIAL" },
    });
  });

  it("invalidateInvoice は INVALID・入金なしにする。もう一度呼んでも成功する（BTCPay は 422 を返す）", async () => {
    const invoice = await create();

    await client.invalidateInvoice(invoice.invoiceId);
    await client.invalidateInvoice(invoice.invoiceId);

    expect((await client.getInvoice(invoice.invoiceId)).observation).toEqual({ status: "INVALID", received: "NONE" });
  });

  it("無効化した invoice への入金は、payment-methods から読んで INVALID・FULL になる（ADR 9）", async () => {
    const invoice = await create();
    const { destination, due } = await paymentMethod(invoice.invoiceId);
    await client.invalidateInvoice(invoice.invoiceId);

    pay(destination, due);

    expect(await waitFor(invoice.invoiceId, (i) => i.observation.received !== "NONE")).toMatchObject({
      observation: { status: "INVALID", received: "FULL" },
    });
    mineBlocks(1);
  });

  // ポートの外の操作（支払い先の取得）は、テストから Greenfield を直接呼ぶ
  async function greenfield<T>(path: string): Promise<T> {
    const response = await fetch(`${config.baseUrl}/api/v1/stores/${config.storeId}${path}`, {
      headers: { Authorization: `token ${config.apiKey}` },
    });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return (await response.json()) as T;
  }

  async function paymentMethod(invoiceId: string): Promise<{ destination: string; due: string }> {
    const [method] = await greenfield<{ destination: string; due: string }[]>(`/invoices/${invoiceId}/payment-methods`);
    return method;
  }

  // BTCPay は NBXplorer 経由で非同期に入金を検知するので、状態が変わるまで待つ
  async function waitFor(invoiceId: string, done: (invoice: BtcpayInvoice) => boolean): Promise<BtcpayInvoice> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const invoice = await client.getInvoice(invoiceId);
      if (done(invoice) || Date.now() > deadline) return invoice;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
});
