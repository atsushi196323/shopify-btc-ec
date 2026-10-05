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
