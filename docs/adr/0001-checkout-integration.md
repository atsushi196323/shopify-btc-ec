# ADR 1: Shopify チェックアウトへの組み込み方式

- ステータス: 提案（下書き。W2 の実装時に確定）
- 日付: 2026-10-01

## コンテキスト
Shopify のチェックアウトに独自の決済方法を出すには Payments App が必要で、
これは Shopify の審査を受けるパートナー向けの仕組み。カスタムアプリでは使えない。
今回は開発ストアのカスタムアプリとして作る。

## 決定
**手動決済方法と、Thank you / 注文状況ページの Checkout UI Extension を組み合わせる。**
- 管理画面で手動決済方法「Bitcoinで支払う」を作る。注文は支払い待ちのまま確定する。
- `orders/create` Webhook で BTCPay の invoice を作る。拡張から問い合わせた時点で未作成なら、冪等に作る（[ADR 5](0005-invoice-creation-dedup-and-orphan-recovery.md)）。
- 拡張で支払いリンクと状態を表示する。
- Settled になったら Admin GraphQL の `orderMarkAsPaid` で支払い済みにする。

## W1 で確認したこと（2026-10-02）
- 開発ストア `bitcoin-ec`（Basic プラン、JPY）に手動決済方法「Bitcoinで支払う」を作り、テスト注文が「支払い待ち」で確定することを確認した。
- Thank you / 注文状況ページの拡張は Basic プランでも使える。

## 未検証事項（W2 の最初に30分で区切って確認する）
- **拡張からアプリの API を呼べるか**: Checkout UI Extension の `network_access = true` には、アプリ単位の承認が必要。
  CLI 4.8 で作った Dev Dashboard のアプリには承認の画面がなく、公開時にエラーになる例が報告されている（2026年9月時点で未解決）。
  最小の Thank you 拡張で、開発プレビューからアプリの API を呼べるかを確かめる。
  呼べない場合は、invoice の作成時に支払いリンクを注文のメタフィールドに書き、拡張はそれを読むだけにする案を検討し、ここに記録する。
  → **2026-10-04 に確認済み（下記）。当初の案のまま進める。**
- **保護された顧客データ**: カスタムアプリには Level 1・2 が最初から付いていて、申請は不要とされている。
  `read_orders` / `write_orders` を `shopify.app.toml` に足し、`orders/create` の Webhook を登録できるかで確かめる。

## W2 で確認したこと（2026-10-04、拡張の通信）
最小の Thank you 拡張（`network_access = true`）から、アプリの `GET /api/extension/ping` を呼んだ。
- **開発プレビューでは呼べる**: 本物の Thank you ページで、セッショントークン付きのリクエストに 200 が返った
  （`authenticate.public.checkout` で検証。`sessionToken.dest` は `bitcoin-ec.myshopify.com`）。
  CLI 4.8.3 でも、開発プレビューの段階では承認を求められなかった。
- **公開（`shopify app deploy`）での承認は未確認**: MVP とデモは開発プレビューで動かすので、ここで止める。
  公開が必要になったときに承認の問題が出たら、メタフィールドを読む案に切り替える。
- 実装で使うこと:
  - 拡張からアプリの URL は `process.env.APP_URL` で得る（CLI がビルド時に埋め込む。開発中はトンネルの URL）。
  - CORS とプリフライトは `authenticate.public.checkout` と `cors()` が扱う。ただし**認証失敗の 401 には CORS ヘッダが付かない**ので、
    拡張からはステータスではなく通信エラーに見える。拡張は通信エラーを「時間をおいて再表示」として扱う。
  - curl などの User-Agent はボットとみなされ 410 になる（ライブラリの仕様）。手で叩くときはブラウザの User-Agent を付ける。
- 開発プレビューの注意（手動 E2E・デモの手順に書く）:
  - ブロックの target（`purchase.thank-you.block.render`）は、置く場所を決めないと表示されない。
    設定なしで表示される静的な target（`purchase.thank-you.customer-information.render-after`）を使う。
  - 拡張は、URL に `?dev=<トンネル>/extensions` が付いたカートから始めた注文でしか読み込まれない。
    CLI のプレビュー用リンクはストアの最初の商品をカートに入れるので、在庫切れだと進めない（開発ストアのギフトカードは販売を続ける設定に変えた）。

## 検討した代替案
- **ヘッドレス + Draft Order**: ストアフロントまで自作する必要があり、工数のわりに決済の設計力は伝わりにくい。
- **注文確認メールに支払いリンクを載せるだけ**: 状態を表示できず、体験が悪い。

## 結果
- 「注文は先に確定し、支払いは後から来る」という非同期の流れになる。期限切れ、再発行、期限後の入金などの論点が生まれる。
- Shopify 標準のチェックアウトをそのまま使える。
- 公式 BTCPay プラグインとほぼ同じ方式なので、自作した部分との比較で説明しやすい。
