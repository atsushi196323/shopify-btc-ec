import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { loadWebhookSecret } from "../../src/adapters/btcpay/config";
import { GreenfieldClient, type GreenfieldConfig } from "../../src/adapters/btcpay/greenfield-client";
import { PrismaInboxRepository } from "../../src/adapters/db/prisma-inbox-repository";
import { PrismaPaymentRepository } from "../../src/adapters/db/prisma-payment-repository";
import { FakeShopifyGateway } from "../../src/adapters/shopify-fake/fake-shopify-gateway";
import { addBitcoinOrder, TEST_SHOP } from "./orders";
import { btcpayConfig } from "./regtest";
import { createTestDb } from "./test-db";
import { startWebhookServer, type WebhookServer } from "./webhook-server";

// 統合テストのアプリ（ADR 10）。テストプロセスの中で、本物の BTCPay の Webhook を port 3000 で受け、
// ルートと同じ処理（署名の検証 → inbox → ワーカー → 無効化・Shopify への反映）を流す。Shopify はフェイク
export type RegtestApp = {
  prisma: PrismaClient;
  config: GreenfieldConfig;
  greenfield: GreenfieldClient;
  payments: PrismaPaymentRepository;
  shopify: FakeShopifyGateway;
  server: WebhookServer;
  // 「Bitcoinで支払う」の支払い待ちの注文をフェイクの Shopify に足す
  addOrder: () => string;
  close: () => Promise<void>;
};

export async function startRegtestApp(): Promise<RegtestApp> {
  const { prisma, cleanup } = createTestDb();
  const config = btcpayConfig();
  const greenfield = new GreenfieldClient(config);
  const payments = new PrismaPaymentRepository(prisma);
  const shopify = new FakeShopifyGateway();
  // secret はアプリと同じく .bootstrap.env（か環境変数）から読む
  const secret = loadWebhookSecret(
    process.env,
    join(__dirname, "..", "..", "..", "..", "infra", "regtest", ".bootstrap.env"),
  );
  const server = await startWebhookServer(
    {
      payments,
      inbox: new PrismaInboxRepository(prisma),
      btcpay: greenfield,
      shopifyFor: async (shop) => {
        if (shop !== TEST_SHOP) throw new Error(`想定しないショップ ${shop}`);
        return shopify;
      },
    },
    secret,
  );
  return {
    prisma,
    config,
    greenfield,
    payments,
    shopify,
    server,
    addOrder: () => addBitcoinOrder(shopify),
    close: async () => {
      await server.close();
      await cleanup();
    },
  };
}
