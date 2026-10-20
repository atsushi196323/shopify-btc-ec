import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { loadWebhookSecret } from "../../src/adapters/btcpay/config";
import { GreenfieldClient, type GreenfieldConfig } from "../../src/adapters/btcpay/greenfield-client";
import { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import type { InvoiceDeps } from "../../src/application/create-invoice";
import type { BtcpayGateway } from "../../src/application/ports/btcpay-gateway";
import type { PaymentRepository } from "../../src/application/ports/payment-repository";
import type { HandleEventDeps } from "../../src/application/process-btcpay-event";
import { composeBtcpayEventDeps, composeInvoiceDeps } from "../../app/composition";
import { addBitcoinOrder, TEST_SHOP } from "./orders";
import { btcpayConfig } from "./regtest";
import { createTestDb } from "./test-db";
import { startWebhookServer, type WebhookServer } from "./webhook-server";

// 統合テストのアプリ（ADR 10）。テストプロセスの中で、本物の BTCPay の Webhook を port 3000 で受け、
// ルートと同じ処理（署名の検証 → inbox → ワーカー → 無効化・Shopify への反映）を流す。Shopify はフェイク。
// 依存は本番と同じ app/composition.ts で組み立て、フェイクの Shopify と BTCPay のデコレータを引数で差し込む
export type RegtestApp = {
  prisma: PrismaClient;
  config: GreenfieldConfig;
  greenfield: GreenfieldClient;
  payments: PaymentRepository;
  shopify: FakeShopifyGateway;
  server: WebhookServer;
  // ワーカーと同じ依存。スイープ（runSweep）にもこれを渡す
  deps: HandleEventDeps;
  // ルート（orders/create・拡張 API）と同じ invoice の依存。btcpay を渡すと、Greenfield の代わりにそれを使う（デコレータの差し込み）
  invoiceDeps: (btcpay?: BtcpayGateway) => InvoiceDeps;
  // 「Bitcoinで支払う」の支払い待ちの注文をフェイクの Shopify に足す
  addOrder: () => string;
  close: () => Promise<void>;
};

export async function startRegtestApp(): Promise<RegtestApp> {
  const { prisma, cleanup } = createTestDb();
  const config = btcpayConfig();
  const greenfield = new GreenfieldClient(config);
  const shopify = new FakeShopifyGateway();
  // secret はアプリと同じく .bootstrap.env（か環境変数）から読む
  const secret = loadWebhookSecret(
    process.env,
    join(__dirname, "..", "..", "..", "..", "infra", "regtest", ".bootstrap.env"),
  );
  const deps = composeBtcpayEventDeps(prisma, greenfield, async (shop) => {
    if (shop !== TEST_SHOP) throw new Error(`想定しないショップ ${shop}`);
    return shopify;
  });
  const server = await startWebhookServer(deps, secret);
  return {
    prisma,
    config,
    greenfield,
    payments: deps.payments,
    shopify,
    server,
    deps,
    invoiceDeps: (btcpay = greenfield) => composeInvoiceDeps(prisma, TEST_SHOP, btcpay, shopify),
    addOrder: () => addBitcoinOrder(shopify),
    close: async () => {
      await server.close();
      await cleanup();
    },
  };
}
