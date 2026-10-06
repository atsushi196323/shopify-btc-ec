import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

// 管理画面のトップ。決済の処理は Webhook と拡張 API が担い、ここには表示だけを置く
export default function Index() {
  return (
    <s-page heading="Bitcoin 決済">
      <s-section>
        <s-paragraph>
          手動決済方法「Bitcoinで支払う」の注文に、BTCPay Server の invoice を作ります。
          支払いの状況は、注文のタグ（btc-review-*）と Thank you ページで確認できます。
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
