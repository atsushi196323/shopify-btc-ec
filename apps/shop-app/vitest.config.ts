import { defineConfig } from "vitest/config";

// vite.config.ts は React Router のプラグインを読み込むので、テストでは使わない。
// 統合テスト（本物の BTCPay と bitcoind が要る）は vitest.integration.config.ts で別に流す
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "**/node_modules/**"],
  },
});
