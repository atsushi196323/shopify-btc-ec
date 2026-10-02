import { defineConfig } from "vitest/config";

// vite.config.ts は React Router のプラグインを読み込むので、テストでは使わない
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
