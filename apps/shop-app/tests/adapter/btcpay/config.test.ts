import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGreenfieldConfig } from "../../../src/adapters/btcpay/config";

describe("loadGreenfieldConfig", () => {
  function bootstrapEnv(text: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "bootstrap-env-")), ".bootstrap.env");
    writeFileSync(path, text);
    return path;
  }

  it(".bootstrap.env の値を読む", () => {
    const path = bootstrapEnv("BTCPAY_URL=http://localhost:49392\nBTCPAY_API_KEY=key\nBTCPAY_STORE_ID=store\nBTCPAY_WEBHOOK_SECRET=s\n");

    expect(loadGreenfieldConfig({}, path)).toEqual({ baseUrl: "http://localhost:49392", apiKey: "key", storeId: "store" });
  });

  it("環境変数を .bootstrap.env より優先する", () => {
    const path = bootstrapEnv("BTCPAY_URL=http://localhost:49392\nBTCPAY_API_KEY=key\nBTCPAY_STORE_ID=store\n");

    expect(loadGreenfieldConfig({ BTCPAY_API_KEY: "from-env" }, path)).toMatchObject({ apiKey: "from-env" });
  });

  it("空文字の環境変数は無視し、.bootstrap.env の値を使う", () => {
    const path = bootstrapEnv("BTCPAY_URL=http://localhost:49392\nBTCPAY_API_KEY=key\nBTCPAY_STORE_ID=store\n");

    expect(loadGreenfieldConfig({ BTCPAY_API_KEY: "" }, path)).toMatchObject({ apiKey: "key" });
  });

  it("CRLF の改行でも値に \\r を含めない", () => {
    const path = bootstrapEnv("BTCPAY_URL=http://localhost:49392\r\nBTCPAY_API_KEY=key\r\nBTCPAY_STORE_ID=store\r\n");

    expect(loadGreenfieldConfig({}, path)).toEqual({ baseUrl: "http://localhost:49392", apiKey: "key", storeId: "store" });
  });

  it("値が揃わなければ例外にする", () => {
    expect(() => loadGreenfieldConfig({ BTCPAY_URL: "http://localhost:49392" }, "/nonexistent/.bootstrap.env")).toThrow(
      "BTCPay の設定がない",
    );
  });
});
