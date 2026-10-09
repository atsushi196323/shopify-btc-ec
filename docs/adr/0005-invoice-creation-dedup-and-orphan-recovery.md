# ADR 5: invoice の二重作成防止と孤児の回復

- ステータス: 提案（下書き。W2 の実装時に確定）
- 日付: 2026-10-01

## コンテキスト
invoice を作る経路は2つある。`orders/create` Webhook と、拡張からの問い合わせ（未作成なら作る）。
両方が同時に届くと、どちらも「未作成」と判断し、BTCPay 側に invoice が2つできる。
BTCPay は外部システムなので、DB のトランザクションでは守れない。
また、BTCPay で invoice を作った後、DB を更新する前にプロセスが落ちると、
BTCPay にだけ invoice が残る（孤児）。

## 決定
**予約行で同時実行を排除し、試行単位の検索で孤児を回復する。**

1. **予約**: 1つのトランザクションで `Payment(shopifyOrderId UNIQUE)`・`InvoiceAttempt(CREATING)`・ポインタを作る。
   INSERT に勝った側だけが BTCPay を呼ぶ。負けた側は既存の行を読んで返す（作成中なら拡張側がリトライする）。
2. **試行単位の冪等性キー**: BTCPay の invoice の `orderId` 欄に **attemptId** を入れる。
   Shopify の注文 ID はメタデータ（`shopifyOrderId`）に入れる。
3. **孤児の回復**: CREATING のまま一定時間が経った試行は、スイープが
   `GET invoices?orderId=<attemptId>` で検索する。見つかれば紐づけ、なければ作成を再試行する。
4. **再発行**も同じ順序で行う（新しい試行の作成とポインタの付け替えを1つのトランザクションで行い、commit 後に BTCPay を呼ぶ）。
   そのため、初回の作成と再発行は同じスイープで回復できる。
5. **`orders/create` の再送**: MVP では `orders/create` を inbox を通さず直接処理する。BTCPay の呼び出しが遅くて Shopify が再送しても、
   再送側は1の UNIQUE に負けて既存の行を返すので重複しない。最初のリクエストが途中で落ちて CREATING のまま残った試行は、3のスイープが回復する。
   拡張の遅延作成は「Payment がまだない」場合だけを担い、CREATING の回復はしない。

## 検討した代替案
- **BTCPay を Shopify の注文 ID で検索するだけ**: 検索と作成の間に競合の隙間が残る。
  また、再発行によって同じ注文に複数の invoice ができると、どれが孤児か判別できない。
- **予約行だけ**: 同時実行は防げるが、クラッシュ後の回復手段がない。

## 結果
- 「外部の副作用はトランザクションに入らない」という問題を、予約と照合の組み合わせで扱う。
- テスト: シナリオ7（競合）、シナリオ8（初回の作成と再発行の両方のクラッシュ回復）。
- W2 の確認項目: BTCPay の支払い画面に `orderId`（attemptId）が表示されるか。表示される場合の見え方を決める。

## W2 で確認したこと（2026-10-05、BTCPay アダプタ）
- **支払い画面に `orderId` は表示されない**: BTCPay 2.4 の支払い画面は、`orderId` をページに埋め込んだ JSON（`srvModel`）に持つだけで、
  テンプレートと `checkout.js` のどちらも表示に使っていない（ページの HTML とスクリプトで確認した）。
  購入者に attemptId の見え方を説明する必要はない。ページのソースには UUID が見えるが、それだけでは注文に結びつかない。
- invoice の作成では `metadata.orderId` に attemptId、`metadata.shopifyOrderId` に Shopify の注文 ID を入れる。
  `GET invoices?orderId=<attemptId>` の結果は、アダプタでも `metadata.orderId` の完全一致で絞る。
- ストアにない invoice の取得は、404 ではなく 403 が返る（権限の検査で弾かれる）。「見つからない」と「権限がない」を区別できないので、
  孤児の回復では取得ではなく検索（0件なら作成を再試行）を使う。
- 本物の BTCPay に対するアダプタのテストは `tests/integration/btcpay/` に置き、`pnpm test:integration` で流す（`pnpm test` には含めない）。

## W2 で決めたこと（2026-10-06、invoice の作成）
- ユースケースは `src/application/create-invoice.ts`。初回の作成（`createInvoiceForOrder`）と、CREATING の試行の回復（`recoverCreatingAttempt`）の2つ。
  回復はスイープ（W4）から試行ごとに呼ぶ。初回の作成と再発行の試行を区別しない。
- **紐づけは「CREATING かつ `btcpayInvoiceId` が NULL」の試行に対する条件付き更新**で行う。先に紐づけた側が勝ち、負けた側は勝った側の invoice を返す。
- 紐づけた invoice の状態は NEW とは限らない（回復では、入金済み・期限切れのこともある）。そのため、紐づけの遷移とフラグもドメインの `applyObservation` で決める。
- BTCPay の呼び出しや紐づけで例外が出たら、そのまま例外を返す。試行は CREATING のまま残り、回復に任せる。
- **同じ試行に invoice が2つできる場合が1つだけ残る**: 作成中の呼び出しが BTCPay の応答を待っている間に、スイープが回復して invoice を作り直した場合。
  紐づくのは先に紐づけた方だけで、もう1つは試行に結びつかないまま BTCPay に残る。購入者に見せるのは紐づいた方の checkout link だけなので、払われることはない。
  スイープが「一定時間」を BTCPay の呼び出しの上限（既定 10 秒）より十分長く取れば起きない。この値は W4 のスイープで決める。
- テスト: `tests/application/create-invoice.test.ts`（DB は本物の SQLite、BTCPay と Shopify はフェイク）。本物の BTCPay でのシナリオ7 は W2 の後半で行う。

## W2 で決めたこと（2026-10-06、orders/create のルート）
- ルートは `app/routes/webhooks.orders.create.tsx`。HMAC の検証（テンプレート）→ ペイロードから注文の GID だけを取り出す → `createInvoiceForOrder` を呼ぶ。
  ペイロードのほかの値は使わない（ADR 4）。依存の組み立ては `app/invoice.server.ts` に置く。
- **例外は 500 のまま返し、Shopify の再送に任せる**。予約の前（注文の取得など）で落ちた場合は、再送で作り直せる。
  予約の後で落ちた場合は、再送は UNIQUE に負けて既存の行を返し、CREATING の試行はスイープが回復する。
- `NOT_ELIGIBLE`・`ORDER_NOT_FOUND`（Bitcoin 以外の支払い方法の注文など）は 200 を返す。再送しても結果は変わらないため。
- アンインストール後に届いてセッションがない Webhook は、何もせず 200 を返す。
- BTCPay の接続設定は、統合テストと同じく環境変数を優先し、なければ `infra/regtest/.bootstrap.env` を読む（`src/adapters/btcpay/config.ts`）。
  設定は invoice を作るたびに読む。設定がなくても管理画面などほかのルートは動き、`down -v` と bootstrap.sh で API キーやストアが変わっても再起動せずに追いつける。
  空文字の環境変数は設定なしとして扱い、ファイルの値を使う。
- Shopify は Webhook の応答を約5秒しか待たないが、BTCPay の呼び出しの上限は 10 秒にしている。超えた場合は 5.1 の想定どおり、再送は既存の行を返し、
  BTCPay で作られた invoice はスイープの孤児回復が `orderId` で見つけて紐づける。スイープ（W4）ができるまでは、その試行は CREATING のまま残る（拡張は作成中として待つ）。

## W2 で確かめたこと（2026-10-09、シナリオ7）
- テストは `apps/shop-app/tests/integration/scenario-07-concurrent-create.test.ts`。本物の BTCPay（regtest）・本物の SQLite・フェイクの Shopify で、
  `createInvoiceForOrder`（orders/create の入口）と `invoiceForExtension`（拡張 API の入口）を10並列ずつ呼ぶ。
- ルート（認証と受け渡しだけ）は通さず、テストプロセスでユースケースに依存を組み立てて渡す。ルートの認証は Shopify のセッションに依存し、フェイクに差し替えられないため。
- テスト用デコレータ（`tests/helpers/btcpay-decorator.ts`）で、BTCPay への作成の直前に 500ms 待たせ、予約に勝った呼び出しが戻る前に残りが既存の行を読む状況を作る。
  例外の注入はシナリオ8（W4）で加える。
- 結果: DB の Payment と試行はどちらも1件、BTCPay への作成依頼は1回、この注文の invoice（`metadata.shopifyOrderId` で絞る）も1件。
  勝った1件以外の19件は CREATING を読み、Webhook は EXISTING、拡張は「準備中」を返した。作成後の問い合わせは同じ checkout link を返す。
