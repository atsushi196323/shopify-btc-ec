import "@shopify/ui-extensions/preact";
import { render } from "preact";

// Thank you ページに支払いリンクと状態を表示する拡張（design.md 5.2、ADR 1）。
// 今は雛形。W2 で拡張 API（process.env.APP_URL + セッショントークン）を呼ぶ形にする
export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-banner heading="Bitcoin でのお支払い">
      <s-text>準備中です。</s-text>
    </s-banner>
  );
}
