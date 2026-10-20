import { createHmac, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { receiveBtcpayWebhook } from "../../../src/adapters/btcpay/webhook-handler";
import { PrismaInboxRepository } from "../../../src/adapters/db/prisma-inbox-repository";
import { PrismaPaymentRepository } from "../../../src/adapters/db/prisma-payment-repository";
import { FakeShopifyGateway } from "../../../src/adapters/shopify-fake/fake-shopify-gateway";
import { createInvoiceForOrder } from "../../../src/application/create-invoice";
import type { InboxRepository } from "../../../src/application/ports/inbox-repository";
import type { HandleEventDeps } from "../../../src/application/process-btcpay-event";
import { FakeBtcpayGateway } from "../../helpers/fake-btcpay";
import { addBitcoinOrder, TEST_SHOP } from "../../helpers/orders";
import { createTestDb } from "../../helpers/test-db";

// BTCPay の Webhook の受信（design.md 5.3 の 1・2、ADR 8）。ルート（app/routes/webhooks.btcpay.tsx）が呼ぶ入口。
// 署名の照合そのものは webhook.test.ts の既知のベクタで、本物の BTCPay からの配信は統合テストで確かめる。
// ここでは、署名が合わない配信を inbox に入れずワーカーにも渡さないこと、重複の配信の扱いを確かめる。DB は本物の SQLite、BTCPay はフェイク
const SECRET = "test-webhook-secret";

describe("receiveBtcpayWebhook", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;
  let btcpay: FakeBtcpayGateway;
  let shopify: FakeShopifyGateway;
  let deps: HandleEventDeps;

  beforeAll(() => {
    ({ prisma, cleanup } = createTestDb());
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(() => {
    btcpay = new FakeBtcpayGateway();
    shopify = new FakeShopifyGateway();
    deps = {
      payments: new PrismaPaymentRepository(prisma),
      inbox: new PrismaInboxRepository(prisma),
      btcpay,
      shopifyFor: async () => shopify,
    };
    // 受信のログで出力を埋めない
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    return () => vi.restoreAllMocks();
  });

  // 紐づけ済みの invoice（NEW・AWAITING_PAYMENT）を1つ作る
  async function awaitingPayment() {
    const shopifyOrderId = addBitcoinOrder(shopify);
    const created = await createInvoiceForOrder({ shop: TEST_SHOP, payments: deps.payments, btcpay, shopify }, shopifyOrderId);
    if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
    return { paymentId: created.payment.paymentId, invoiceId: created.invoice.invoiceId, shopifyOrderId };
  }

  const body = (fields: Record<string, unknown>) => JSON.stringify({ isRedelivery: false, timestamp: 1791526808, ...fields });
  const sign = (raw: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

  function request(raw: string, signature: string | null = sign(raw)): Request {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (signature !== null) headers.set("BTCPay-Sig", signature);
    return new Request("http://localhost:3000/webhooks/btcpay", { method: "POST", headers, body: raw });
  }

  const inboxRows = (eventId: string) => prisma.inbox.findMany({ where: { eventId } });
  const paymentRow = (paymentId: string) => prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

  it("署名が合えば inbox に保存して 200 を返し、ワーカーが状態を進めて Shopify に反映する", async () => {
    const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();
    btcpay.setObservation(invoiceId, { status: "SETTLED", received: "FULL" });
    const deliveryId = randomUUID();

    const { response, processed } = await receiveBtcpayWebhook(
      request(body({ deliveryId, type: "InvoiceSettled", invoiceId })),
      deps,
      SECRET,
    );

    expect(response.status).toBe(200);
    expect(await processed).toMatchObject({ event: { outcome: "APPLIED" }, sync: { outcome: "SYNCED" } });
    expect(await inboxRows(deliveryId)).toMatchObject([{ source: "BTCPAY", status: "DONE" }]);
    expect(await paymentRow(paymentId)).toMatchObject({ status: "PAID", shopifySync: "DONE" });
    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
  });

  describe("署名が合わない配信は、401 を返し、inbox にも入れずワーカーにも渡さない", () => {
    it.each([
      ["別の secret で署名した", (raw: string) => sign(raw, "other-secret")],
      ["署名の後にボディを書き換えた", (raw: string) => sign(raw.replace("InvoiceSettled", "InvoiceProcessing"))],
      ["ヘッダがない", () => null],
      ["形が違う", () => "not-a-signature"],
    ])("%s", async (_label, signatureOf) => {
      const { paymentId, invoiceId } = await awaitingPayment();
      btcpay.setObservation(invoiceId, { status: "SETTLED", received: "FULL" });
      const deliveryId = randomUUID();
      const raw = body({ deliveryId, type: "InvoiceSettled", invoiceId });
      let fetched = 0;
      const counting: HandleEventDeps = {
        ...deps,
        btcpay: Object.assign(Object.create(btcpay) as FakeBtcpayGateway, {
          getInvoice: (id: string) => (fetched++, btcpay.getInvoice(id)),
        }),
      };

      const { response, processed } = await receiveBtcpayWebhook(request(raw, signatureOf(raw)), counting, SECRET);

      expect(response.status).toBe(401);
      expect(await processed).toBeNull();
      expect(await inboxRows(deliveryId)).toEqual([]);
      expect(fetched).toBe(0);
      expect(await paymentRow(paymentId)).toMatchObject({ status: "AWAITING_PAYMENT" });
      expect(shopify.markedAsPaid).toEqual([]);
    });
  });

  it("invoice に関係しないイベントは、保存せずに 200 を返す（BTCPay に再送させない）", async () => {
    const deliveryId = randomUUID();

    const { response, processed } = await receiveBtcpayWebhook(
      request(body({ deliveryId, type: "PayoutCreated", payoutId: "p1" })),
      deps,
      SECRET,
    );

    expect(response.status).toBe(200);
    expect(await processed).toBeNull();
    expect(await inboxRows(deliveryId)).toEqual([]);
  });

  it("処理済みの配信がもう一度届いても、inbox の行は1つで、ワーカーは何もしない", async () => {
    const { invoiceId, shopifyOrderId } = await awaitingPayment();
    btcpay.setObservation(invoiceId, { status: "SETTLED", received: "FULL" });
    const deliveryId = randomUUID();
    const raw = body({ deliveryId, type: "InvoiceSettled", invoiceId });
    await (await receiveBtcpayWebhook(request(raw), deps, SECRET)).processed;

    const { response, processed } = await receiveBtcpayWebhook(request(raw), deps, SECRET);

    expect(response.status).toBe(200);
    expect(await processed).toEqual({ event: { outcome: "ALREADY_PROCESSED" }, invalidation: null, sync: null });
    expect(await inboxRows(deliveryId)).toMatchObject([{ status: "DONE" }]);
    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
  });

  it("前の配信の処理が失敗して PENDING のまま残っていれば、同じ配信の再送で処理する", async () => {
    const { paymentId, invoiceId } = await awaitingPayment();
    btcpay.setObservation(invoiceId, { status: "SETTLED", received: "FULL" });
    const deliveryId = randomUUID();
    const raw = body({ deliveryId, type: "InvoiceSettled", invoiceId });
    const unreachable: HandleEventDeps = {
      ...deps,
      btcpay: Object.assign(Object.create(btcpay) as FakeBtcpayGateway, {
        getInvoice: () => Promise.reject(new Error("BTCPay に届かない")),
      }),
    };
    expect(await (await receiveBtcpayWebhook(request(raw), unreachable, SECRET)).processed).toMatchObject({
      event: { outcome: "RETRY" },
    });

    const { processed } = await receiveBtcpayWebhook(request(raw), deps, SECRET);

    expect(await processed).toMatchObject({ event: { outcome: "APPLIED" } });
    expect(await inboxRows(deliveryId)).toMatchObject([{ status: "DONE", attempts: 1 }]);
    expect(await paymentRow(paymentId)).toMatchObject({ status: "PAID" });
  });

  it("ワーカーが例外を投げても 200 を返し、行は PENDING のまま残る（スイープが再処理する）", async () => {
    const { invoiceId } = await awaitingPayment();
    const deliveryId = randomUUID();
    const inbox = deps.inbox as PrismaInboxRepository;
    const broken: HandleEventDeps = {
      ...deps,
      btcpay: Object.assign(Object.create(btcpay) as FakeBtcpayGateway, {
        getInvoice: () => Promise.reject(new Error("BTCPay に届かない")),
      }),
      inbox: Object.assign(Object.create(inbox) as InboxRepository, {
        recordFailure: () => Promise.reject(new Error("SQLITE_BUSY")),
      }),
    };

    const { response, processed } = await receiveBtcpayWebhook(
      request(body({ deliveryId, type: "InvoiceSettled", invoiceId })),
      broken,
      SECRET,
    );

    expect(response.status).toBe(200);
    expect(await processed).toBeNull();
    expect(await inboxRows(deliveryId)).toMatchObject([{ status: "PENDING" }]);
  });
});
