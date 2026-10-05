import { defineConfig } from "vitest/config";

// 統合テスト。infra/regtest の compose と bootstrap.sh が済んでいることが前提（ADR 10）
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60_000,
    // 同じ BTCPay と bitcoind を使うので、ファイルを並列に流さない
    fileParallelism: false,
  },
});
