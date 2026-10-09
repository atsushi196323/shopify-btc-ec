import { describe, expect, it } from "vitest";
import { parseBtcpayWebhookEvent, verifyBtcpaySignature } from "../../../src/adapters/btcpay/webhook";

// 本体は 2026-10-09 に regtest の BTCPay 2.4.4 から受け取った InvoiceCreated の配信（改行と字下げもそのまま）。
// 署名は、この本体と下の secret から openssl で計算した値（既知のベクタ）:
//   printf '%s' "$BODY" | openssl dgst -sha256 -hmac test-webhook-secret
// 本物の secret での検証は、統合テストで BTCPay から届いた配信に対して行う
const BODY = `{
  "deliveryId": "KZkkgYCQ2wdfE6ZD3MmRVk",
  "webhookId": "KEVtSpDLGNeZgYWmRdvaX6",
  "originalDeliveryId": "KZkkgYCQ2wdfE6ZD3MmRVk",
  "isRedelivery": false,
  "type": "InvoiceCreated",
  "timestamp": 1791526808,
  "storeId": "EQHUT7DMKiJtwuqytuF6iqqoPS2RLxF4nez4x1cisMC8",
  "invoiceId": "Xb6V4iy46nVCVvq22ksjfo",
  "metadata": {
    "orderId": "vector-capture"
  }
}`;
const SECRET = "test-webhook-secret";
const SIGNATURE = "sha256=aa94239743778d04355eb1eec8bf764f865ad77315e917bcf4ff3e8c2d738196";

describe("verifyBtcpaySignature", () => {
  it("既知のベクタの署名を受け入れる", () => {
    expect(verifyBtcpaySignature(BODY, SIGNATURE, SECRET)).toBe(true);
  });

  it("16進の大文字・小文字は区別しない", () => {
    const upper = `sha256=${SIGNATURE.slice("sha256=".length).toUpperCase()}`;
    expect(verifyBtcpaySignature(BODY, upper, SECRET)).toBe(true);
  });

  it("ボディが1文字でも違えば拒む（整形し直したボディも拒む）", () => {
    expect(verifyBtcpaySignature(BODY.replace("InvoiceCreated", "InvoiceSettled"), SIGNATURE, SECRET)).toBe(false);
    expect(verifyBtcpaySignature(JSON.stringify(JSON.parse(BODY)), SIGNATURE, SECRET)).toBe(false);
  });

  it("secret が違えば拒む", () => {
    expect(verifyBtcpaySignature(BODY, SIGNATURE, "other-secret")).toBe(false);
  });

  it("ヘッダがない・形が違えば拒む", () => {
    expect(verifyBtcpaySignature(BODY, null, SECRET)).toBe(false);
    expect(verifyBtcpaySignature(BODY, SIGNATURE.slice("sha256=".length), SECRET)).toBe(false);
    expect(verifyBtcpaySignature(BODY, `sha1=${SIGNATURE.slice("sha256=".length)}`, SECRET)).toBe(false);
    expect(verifyBtcpaySignature(BODY, SIGNATURE.slice(0, -2), SECRET)).toBe(false);
  });
});

describe("parseBtcpayWebhookEvent", () => {
  it("配信の ID・種類・invoice ID を取り出す", () => {
    expect(parseBtcpayWebhookEvent(BODY)).toEqual({
      deliveryId: "KZkkgYCQ2wdfE6ZD3MmRVk",
      type: "InvoiceCreated",
      invoiceId: "Xb6V4iy46nVCVvq22ksjfo",
    });
  });

  it("invoice に関係しないイベントと、形の崩れたボディは null", () => {
    expect(parseBtcpayWebhookEvent(JSON.stringify({ deliveryId: "d", type: "PayoutCreated", payoutId: "p" }))).toBeNull();
    expect(parseBtcpayWebhookEvent(JSON.stringify({ deliveryId: "", type: "InvoiceCreated", invoiceId: "i" }))).toBeNull();
    expect(parseBtcpayWebhookEvent("not json")).toBeNull();
    expect(parseBtcpayWebhookEvent("null")).toBeNull();
  });
});
