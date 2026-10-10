import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaInboxRepository } from "../../src/adapters/db/prisma-inbox-repository";
import { PrismaPaymentRepository } from "../../src/adapters/db/prisma-payment-repository";
import { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import { createInvoiceForOrder } from "../../src/application/create-invoice";
import type { ShopifyGateway } from "../../src/application/ports/shopify-gateway";
import { handleBtcpayEvent, type HandleEventDeps } from "../../src/application/process-btcpay-event";
import { MAX_SYNC_ROUNDS, reviewTag, syncPaymentToShopify } from "../../src/application/sync-to-shopify";
import type { InvoiceObservation } from "../../src/domain/payment";
import { FakeBtcpayGateway } from "../helpers/fake-btcpay";
import { createTestDb } from "../helpers/test-db";

const SHOP = "test-shop.myshopify.com";

// Shopify への反映（design.md 4章「Shopify への反映」、ADR 8 の決定4）。DB は本物の SQLite、BTCPay と Shopify はフェイク
describe("syncPaymentToShopify", () => {
  let prisma: PrismaClient;
  let cleanup: () => Promise<void>;
  let btcpay: FakeBtcpayGateway;
  let shopify: FakeShopifyGateway;
  let payments: PrismaPaymentRepository;
  let deps: HandleEventDeps;
  // shopifyFor に渡されたショップ
  let requestedShops: string[];

  beforeAll(() => {
    ({ prisma, cleanup } = createTestDb());
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(() => {
    btcpay = new FakeBtcpayGateway();
    shopify = new FakeShopifyGateway();
    payments = new PrismaPaymentRepository(prisma);
    requestedShops = [];
    deps = {
      payments,
      inbox: new PrismaInboxRepository(prisma),
      btcpay,
      shopifyFor: async (shop) => {
        requestedShops.push(shop);
        return shopify;
      },
    };
  });

  // 紐づけ済みの invoice（NEW・AWAITING_PAYMENT）を1つ作る
  async function awaitingPayment() {
    const shopifyOrderId = `gid://shopify/Order/${randomUUID()}`;
    shopify.addOrder({
      shopifyOrderId,
      paymentGatewayNames: ["Bitcoinで支払う"],
      financialStatus: "PENDING",
      cancelled: false,
      presentmentCurrencyCode: "JPY",
      outstanding: { amount: "1000.0", currencyCode: "JPY" },
    });
    const created = await createInvoiceForOrder({ shop: SHOP, payments, btcpay, shopify }, shopifyOrderId);
    if (created.outcome !== "CREATED") throw new Error(`CREATED ではない: ${created.outcome}`);
    return { paymentId: created.payment.paymentId, invoiceId: created.invoice.invoiceId, shopifyOrderId };
  }

  // Webhook が届いたときと同じく、ワーカーの1件分（保存 → 反映）を流す
  async function observe(invoiceId: string, observation: InvoiceObservation) {
    btcpay.setObservation(invoiceId, observation);
    const { inboxId } = await deps.inbox.saveBtcpayEvent({ eventId: randomUUID(), type: "InvoiceUpdated", invoiceId });
    return handleBtcpayEvent(deps, inboxId);
  }

  const paymentRow = (paymentId: string) => prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

  it("ワーカーが PAID を保存した直後に、Payment のショップで注文を支払い済みにし、DONE にする", async () => {
    const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();

    const handled = await observe(invoiceId, { status: "SETTLED", received: "FULL" });

    expect(handled).toMatchObject({ event: { outcome: "APPLIED" }, sync: { outcome: "SYNCED" } });
    expect(requestedShops).toEqual([SHOP]);
    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
    expect(shopify.orderTags(shopifyOrderId)).toEqual([]);
    expect(await paymentRow(paymentId)).toMatchObject({ status: "PAID", shopifySync: "DONE", shopifySyncError: null });
  });

  it("DONE なら何もしない。PENDING に戻っても、支払い済みの注文には orderMarkAsPaid を呼ばない", async () => {
    const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();
    await observe(invoiceId, { status: "SETTLED", received: "FULL" });

    expect(await syncPaymentToShopify(deps, paymentId)).toEqual({ outcome: "NOT_PENDING" });
    await prisma.payment.update({ where: { id: paymentId }, data: { shopifySync: "PENDING" } });
    expect(await syncPaymentToShopify(deps, paymentId)).toEqual({ outcome: "SYNCED" });

    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
  });

  it("未対応のフラグからタグを付ける。対応済みのフラグのタグは付けない", async () => {
    const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();
    const { currentAttemptId } = await paymentRow(paymentId);
    await prisma.reviewFlag.create({
      data: { id: randomUUID(), paymentId, attemptId: currentAttemptId!, reason: "LATE_PAYMENT", resolvedAt: new Date() },
    });

    expect(await observe(invoiceId, { status: "SETTLED", received: "OVER" })).toMatchObject({ sync: { outcome: "SYNCED" } });

    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
    expect(shopify.orderTags(shopifyOrderId)).toEqual(["btc-review-overpaid"]);
  });

  it.each([
    ["キャンセル済み", { cancelled: true }],
    ["返金済み", { financialStatus: "REFUNDED" }],
    ["取り消し済み", { financialStatus: "VOIDED" }],
  ])("%s の注文は支払い済みにせず、そのことをタグで知らせて DONE にする", async (_label, change) => {
    const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();
    shopify.addOrder({ ...(await shopify.getOrder(shopifyOrderId))!, ...change });

    // フラグのない全額の入金でも、支払い済みにできなかったことは Shopify で見える
    expect(await observe(invoiceId, { status: "SETTLED", received: "FULL" })).toMatchObject({ sync: { outcome: "SYNCED" } });

    expect(shopify.markedAsPaid).toEqual([]);
    expect(shopify.orderTags(shopifyOrderId)).toEqual(["btc-review-not-marked-paid"]);
    expect(await paymentRow(paymentId)).toMatchObject({ status: "PAID", shopifySync: "DONE", shopifySyncError: null });
  });

  it("支払い済みにできない注文でも、フラグのタグは付く", async () => {
    const { invoiceId, shopifyOrderId } = await awaitingPayment();
    shopify.addOrder({ ...(await shopify.getOrder(shopifyOrderId))!, cancelled: true });

    await observe(invoiceId, { status: "SETTLED", received: "OVER" });

    expect(shopify.orderTags(shopifyOrderId)).toEqual(["btc-review-not-marked-paid", "btc-review-overpaid"]);
  });

  it("PAID でなくフラグもなければ、Shopify は呼ばずに DONE にする", async () => {
    const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();

    expect(await observe(invoiceId, { status: "PROCESSING", received: "FULL" })).toMatchObject({
      sync: { outcome: "SYNCED" },
    });

    expect(shopify.markedAsPaid).toEqual([]);
    expect(shopify.orderTags(shopifyOrderId)).toEqual([]);
    expect(await paymentRow(paymentId)).toMatchObject({ status: "CONFIRMING", shopifySync: "DONE" });
  });

  it("Shopify の呼び出しに失敗したら PENDING のまま失敗を記録し、次の反映で追いつく", async () => {
    const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();
    const failing: ShopifyGateway = {
      getOrder: (id) => shopify.getOrder(id),
      markOrderAsPaid: async () => {
        throw new Error("Shopify が一時的に応答しない");
      },
      addOrderTags: (id, tags) => shopify.addOrderTags(id, tags),
    };

    const handled = await handleBtcpayEvent({ ...deps, shopifyFor: async () => failing }, await receiveSettled(invoiceId));

    expect(handled).toEqual({
      event: expect.objectContaining({ outcome: "APPLIED" }),
      invalidation: null,
      sync: { outcome: "FAILED", error: "Shopify が一時的に応答しない" },
    });
    // イベントの保存は commit 済み。反映だけが残っている
    expect(await paymentRow(paymentId)).toMatchObject({
      status: "PAID",
      shopifySync: "PENDING",
      shopifySyncError: "Shopify が一時的に応答しない",
    });

    expect(await syncPaymentToShopify(deps, paymentId)).toEqual({ outcome: "SYNCED" });
    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
    expect(await paymentRow(paymentId)).toMatchObject({ shopifySync: "DONE", shopifySyncError: null });
  });

  it("反映中に別の変更が入ったら、読み直して反映し直してから DONE にする", async () => {
    const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();
    await observe(invoiceId, { status: "PROCESSING", received: "FULL" });
    await receiveSettledWithoutSync(invoiceId);

    let round = 0;
    const result = await syncPaymentToShopify(
      {
        payments,
        shopifyFor: async () => {
          // 1回目の反映の最中に、別の処理が Payment を更新した状況にする
          if (round++ === 0) await prisma.payment.update({ where: { id: paymentId }, data: { version: { increment: 1 } } });
          return shopify;
        },
      },
      paymentId,
    );

    expect(result).toEqual({ outcome: "SYNCED" });
    expect(round).toBe(2);
    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
    expect(await paymentRow(paymentId)).toMatchObject({ shopifySync: "DONE" });
  });

  it(`別の変更が ${MAX_SYNC_ROUNDS} 回続いたら、PENDING のまま残す`, async () => {
    const { paymentId, invoiceId } = await awaitingPayment();
    await receiveSettledWithoutSync(invoiceId);

    const result = await syncPaymentToShopify(
      {
        payments,
        shopifyFor: async () => {
          await prisma.payment.update({ where: { id: paymentId }, data: { version: { increment: 1 } } });
          return shopify;
        },
      },
      paymentId,
    );

    expect(result).toEqual({ outcome: "SUPERSEDED" });
    expect(await paymentRow(paymentId)).toMatchObject({ shopifySync: "PENDING" });
  });

  it("同じ Payment の反映を並行に呼んでも、orderMarkAsPaid は1回", async () => {
    const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();
    await receiveSettledWithoutSync(invoiceId);

    const results = await Promise.all(Array.from({ length: 5 }, () => syncPaymentToShopify(deps, paymentId)));

    expect(results.map((r) => r.outcome).sort()).toEqual(["NOT_PENDING", "NOT_PENDING", "NOT_PENDING", "NOT_PENDING", "SYNCED"]);
    expect(shopify.markedAsPaid).toEqual([shopifyOrderId]);
  });

  it("支払い済みにできなくても、タグは先に付いている", async () => {
    const { paymentId, invoiceId, shopifyOrderId } = await awaitingPayment();
    const failing: ShopifyGateway = {
      getOrder: (id) => shopify.getOrder(id),
      markOrderAsPaid: async () => {
        throw new Error("Order cannot be marked as paid.");
      },
      addOrderTags: (id, tags) => shopify.addOrderTags(id, tags),
    };
    btcpay.setObservation(invoiceId, { status: "SETTLED", received: "OVER" });
    const { inboxId } = await deps.inbox.saveBtcpayEvent({ eventId: randomUUID(), type: "InvoiceSettled", invoiceId });

    expect(await handleBtcpayEvent({ ...deps, shopifyFor: async () => failing }, inboxId)).toMatchObject({
      sync: { outcome: "FAILED" },
    });
    expect(shopify.orderTags(shopifyOrderId)).toEqual(["btc-review-overpaid"]);
    expect(await paymentRow(paymentId)).toMatchObject({ shopifySync: "PENDING" });
  });

  it("反映の中の DB の例外は、保存済みのイベントの結果と分けて FAILED で返す", async () => {
    const { invoiceId } = await awaitingPayment();
    btcpay.setObservation(invoiceId, { status: "SETTLED", received: "FULL" });
    const { inboxId } = await deps.inbox.saveBtcpayEvent({ eventId: randomUUID(), type: "InvoiceSettled", invoiceId });
    const brokenPayments = Object.create(payments) as PrismaPaymentRepository;
    brokenPayments.markSynced = () => Promise.reject(new Error("SQLITE_BUSY"));

    expect(await handleBtcpayEvent({ ...deps, payments: brokenPayments }, inboxId)).toEqual({
      event: expect.objectContaining({ outcome: "APPLIED" }),
      invalidation: null,
      sync: { outcome: "FAILED", error: "SQLITE_BUSY" },
    });
  });

  it("タグは理由を小文字とハイフンにして btc-review- を付ける", () => {
    expect(reviewTag("LATE_PAYMENT")).toBe("btc-review-late-payment");
    expect(reviewTag("DOUBLE_PAYMENT")).toBe("btc-review-double-payment");
  });

  async function receiveSettled(invoiceId: string): Promise<string> {
    btcpay.setObservation(invoiceId, { status: "SETTLED", received: "FULL" });
    const { inboxId } = await deps.inbox.saveBtcpayEvent({ eventId: randomUUID(), type: "InvoiceSettled", invoiceId });
    return inboxId;
  }

  // PAID まで保存するが、反映はまだ呼ばない（PENDING のまま）
  async function receiveSettledWithoutSync(invoiceId: string): Promise<void> {
    const inboxId = await receiveSettled(invoiceId);
    await handleBtcpayEvent({ ...deps, shopifyFor: () => Promise.reject(new Error("まだ反映しない")) }, inboxId);
  }
});
