import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Thank you ページに支払いリンクと状態を表示する拡張（design.md 5.2、ADR 1・4）。
// アプリの拡張 API（POST /api/extension/invoice）に問い合わせ、返ってきた表示状態をそのまま描く
export default async () => {
  render(<Extension />, document.body);
};

const API_URL = `${process.env.APP_URL}/api/extension/invoice`;

// 拡張 API が返す表示状態（src/application/extension-invoice.ts の ExtensionView）。サーバーに状態を足したら、ここにも足す
const API_STATES = ["PREPARING", "AWAITING_PAYMENT", "CONFIRMING", "PAID", "EXPIRED", "CONTACT_SHOP", "NOT_APPLICABLE"];

// 作成中・通信エラーのときは短い間隔で問い合わせ直す。存在しない注文には PREPARING が返り続けるので、続けて失敗できる回数に上限を設ける
const RETRY_INTERVAL_MS = 3_000;
const MAX_RETRIES = 20;
// まだ変わりうる状態（LIVE_STATES）のときは、変化を拾うために間隔をあけて問い合わせ直す（同じ状態のまま約30分で止める）。
// 問い合わせのたびにサーバーが Admin API と BTCPay を呼ぶので、間隔は長めに取る
const REFRESH_INTERVAL_MS = 30_000;
const MAX_REFRESHES = 60;
// EXPIRED も含める。期限後の入金で UNRESOLVED（CONTACT_SHOP）に進むことがあるため（design.md 4章）
const LIVE_STATES = ["AWAITING_PAYMENT", "CONFIRMING", "EXPIRED"];
// 問い合わせ直しても結果が変わらない応答（不正な注文 ID の 400、ボット判定の 410 など）。429 などはほかのエラーと同じく問い合わせ直す
const PERMANENT_STATUSES = [400, 404, 410];

function Extension() {
  // view は拡張 API の返り値（{ state, checkoutLink? }）に、拡張だけの状態を足したもの。
  // LOADING: 最初の応答の前 / ERROR: 通信エラー（問い合わせ直し中） / GAVE_UP: 問い合わせをやめた
  // stale: true は、変わりうる状態の表示のまま問い合わせをやめた（最新の状態ではないかもしれない）ことを表す
  const [view, setView] = useState({ state: "LOADING" });

  useEffect(() => {
    let stopped = false;
    let timer;
    let retries = 0;
    let refreshes = 0;
    let lastState = null;

    async function poll() {
      const next = await fetchView();
      if (stopped) return;

      if (next.state === "PREPARING" || next.state === "ERROR") {
        retries += 1;
        const givingUp = next.permanent || retries > MAX_RETRIES;
        // 支払いリンクなどをすでに表示していれば、一時的な失敗でそれを消さない。
        // その場合は上流（Admin API・BTCPay）が失敗している可能性が高いので、間隔も短くしない
        const showing = isLive(lastState);
        setView((current) => {
          if (isLive(current.state)) return givingUp ? { ...current, stale: true } : current;
          return givingUp ? { state: "GAVE_UP" } : next;
        });
        if (!givingUp) timer = setTimeout(poll, showing ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS);
        return;
      }

      retries = 0;
      // 状態が変わったら、その状態で問い合わせ直せる回数を数え直す（支払い待ちの後の入金確認中が、すぐに止まらないように）
      if (next.state !== lastState) refreshes = 0;
      lastState = next.state;
      if (!isLive(next.state)) return setView(next); // PAID・CONTACT_SHOP・NOT_APPLICABLE では止める
      refreshes += 1;
      const givingUp = refreshes > MAX_REFRESHES;
      setView(givingUp ? { ...next, stale: true } : next);
      if (!givingUp) timer = setTimeout(poll, REFRESH_INTERVAL_MS);
    }

    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return <View view={view} />;
}

function isLive(state) {
  return LIVE_STATES.includes(state);
}

// 認証失敗の 401 には CORS ヘッダが付かず、通信エラーとして例外になる（ADR 1）。5xx などとあわせて ERROR として問い合わせ直す
async function fetchView() {
  try {
    const shopifyOrderId = shopify.orderConfirmation.value.order.id;
    const token = await shopify.sessionToken.get();
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ shopifyOrderId }),
    });
    if (!response.ok) return { state: "ERROR", permanent: PERMANENT_STATUSES.includes(response.status) };
    return validView(await response.json());
  } catch {
    return { state: "ERROR" };
  }
}

// 知らない状態（API だけを先に変えた場合など）や、リンクのない支払い待ちは、表示を決められないので通信エラーと同じに扱う
function validView(view) {
  if (!API_STATES.includes(view?.state)) return { state: "ERROR" };
  if (view.state === "AWAITING_PAYMENT" && !(typeof view.checkoutLink === "string" && view.checkoutLink)) {
    return { state: "ERROR" };
  }
  return view;
}

// Bitcoin の注文かどうかは、拡張 API が答えるまで分からない。待っている間や失敗したときの表示を Bitcoin 以外の注文に出さないよう、
// 手動決済方法が選ばれた注文にだけ出す（「Bitcoinで支払う」は手動決済方法。ADR 1）。支払いリンクなどの表示はサーバーの答えに従う
function isManualPaymentOrder() {
  return (shopify.selectedPaymentOptions?.value ?? []).some((option) => option.type === "manualPayment");
}

function View({ view }) {
  switch (view.state) {
    case "AWAITING_PAYMENT":
      return (
        <s-banner heading="Bitcoin でのお支払い" tone="info">
          <s-stack gap="base">
            <s-text>下のボタンから、Bitcoin でお支払いください。お支払いの期限を過ぎると、このリンクは使えなくなります。</s-text>
            <s-button href={view.checkoutLink} target="_blank" variant="primary">
              Bitcoin で支払う
            </s-button>
            {view.stale && <StaleNotice />}
          </s-stack>
        </s-banner>
      );
    case "CONFIRMING":
      return (
        <s-banner heading="入金を確認しています" tone="info">
          <s-stack gap="base">
            <s-text>入金を受け付けました。ブロックチェーンでの承認を待っています。</s-text>
            {view.stale && <StaleNotice />}
          </s-stack>
        </s-banner>
      );
    case "PAID":
      return (
        <s-banner heading="お支払いが完了しました" tone="success">
          <s-text>Bitcoin でのお支払いを確認しました。</s-text>
        </s-banner>
      );
    case "EXPIRED":
      return (
        <s-banner heading="お支払いの期限が切れました" tone="warning">
          <s-stack gap="base">
            <s-text>期限までに入金を確認できませんでした。</s-text>
            {view.stale && <StaleNotice />}
          </s-stack>
        </s-banner>
      );
    case "CONTACT_SHOP":
      return (
        <s-banner heading="ショップから連絡します" tone="warning">
          <s-text>お支払いの確認に時間がかかっています。ショップからご連絡します。</s-text>
        </s-banner>
      );
    case "PREPARING":
      return isManualPaymentOrder() ? <Waiting text="お支払いの準備をしています。" /> : null;
    case "ERROR":
      return isManualPaymentOrder() ? <Waiting text="お支払いの情報を取得できません。接続を再試行しています。" /> : null;
    case "GAVE_UP":
      return isManualPaymentOrder() ? (
        <s-banner heading="Bitcoin でのお支払い" tone="warning">
          <s-text>お支払いの情報を取得できませんでした。時間をおいて、このページを再表示してください。</s-text>
        </s-banner>
      ) : null;
    default:
      // LOADING（最初の応答の前）・NOT_APPLICABLE（Bitcoin 以外の注文など）は何も表示しない
      return null;
  }
}

function Waiting({ text }) {
  return (
    <s-banner heading="Bitcoin でのお支払い" tone="info">
      <s-stack direction="inline" gap="base">
        <s-spinner size="small" accessibilityLabel="読み込み中" />
        <s-text>{text}</s-text>
      </s-stack>
    </s-banner>
  );
}

function StaleNotice() {
  return <s-text tone="neutral">最新の状態は、このページを再表示して確認してください。</s-text>;
}
