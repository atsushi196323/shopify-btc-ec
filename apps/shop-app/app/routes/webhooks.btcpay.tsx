import type { ActionFunctionArgs } from "react-router";
import { loadWebhookSecret } from "../../src/adapters/btcpay/config";
import { receiveBtcpayWebhook } from "../../src/adapters/btcpay/webhook-handler";
import { btcpayEventDeps } from "../invoice.server";

// BTCPay の Webhook（design.md 5.3、ADR 8）。infra/regtest/bootstrap.sh が http://host.docker.internal:3000/webhooks/btcpay に登録する。
// 署名の検証・inbox への保存・ワーカーへの受け渡しは src/adapters/btcpay/webhook-handler.ts が行う。ワーカーの終わりは待たない
export const action = async ({ request }: ActionFunctionArgs) => {
  const { response } = await receiveBtcpayWebhook(request, btcpayEventDeps(), loadWebhookSecret());
  return response;
};
