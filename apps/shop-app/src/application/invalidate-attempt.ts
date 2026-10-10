// 自分で行う invoice の無効化（design.md 4章「古い試行に期限後の入金があったとき」、ADR 9「自分で無効化した invoice」）。
// 無効化の意図（invalidatedByUs）を先に DB に記録してから、BTCPay を呼ぶ。
// 先に記録しておけば、無効化の直後に届いた入金も、自分で無効化した試行への入金（DOUBLE_PAYMENT）として判定できる。
// BTCPay の呼び出しが失敗しても、スイープが「UNRESOLVED なのに現在の試行が NEW」を見つけて、ここをもう一度呼ぶ（冪等）
import { attemptToInvalidate } from "../domain/payment";
import type { BtcpayGateway } from "./ports/btcpay-gateway";
import type { PaymentRepository } from "./ports/payment-repository";

// version の競合で読み直す回数（ワーカーと同じ）
const MAX_CONFLICT_RETRIES = 3;

export type InvalidateDeps = { payments: PaymentRepository; btcpay: BtcpayGateway };

// INVALIDATED: BTCPay で無効化した（すでに無効だった場合も含む） / NOT_NEEDED: 判定の結果、無効化する試行ではなかった
export type InvalidateResult = { outcome: "INVALIDATED" | "NOT_NEEDED" };

export async function invalidateAttempt(deps: InvalidateDeps, attemptId: string): Promise<InvalidateResult> {
  for (let i = 0; i < MAX_CONFLICT_RETRIES; i++) {
    const loaded = await deps.payments.loadForAttempt(attemptId);
    if (!loaded) throw new Error(`試行 ${attemptId} がない`);
    if (attemptToInvalidate(loaded.state) !== attemptId) return { outcome: "NOT_NEEDED" };
    // NEW の試行には必ず invoice が紐づいている
    if (loaded.btcpayInvoiceId === null) throw new Error(`試行 ${attemptId} に invoice が紐づいていない`);

    const attempt = loaded.state.attempts.find((a) => a.id === attemptId);
    if (!attempt?.invalidatedByUs) {
      const saved = await deps.payments.markInvalidatedByUs({
        paymentId: loaded.paymentId,
        expectedVersion: loaded.version,
        attemptId,
      });
      if (!saved) continue;
    }
    await deps.btcpay.invalidateInvoice(loaded.btcpayInvoiceId);
    return { outcome: "INVALIDATED" };
  }
  throw new Error(`version の競合が ${MAX_CONFLICT_RETRIES} 回続いた`);
}
