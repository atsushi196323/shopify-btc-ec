# ADR 4: 請求額はサーバー側で取得する／ゲスト購入のリスクの受け入れ

- ステータス: 承認（2026-10-10、W2 の金額の検証・拡張 API と W3 のショップの確かめ方を、実装とテスト・手動の E2E で確認）
- 日付: 2026-10-01

## コンテキスト
Thank you ページの拡張から、アプリの API（`POST /invoice {shopifyOrderId}`）を呼ぶ。
何も検証しないと、他人の注文 ID を指定して金額や invoice を取得できてしまう。
また、クライアントが送ってきた金額を信用すると、改ざんされた金額で invoice が作られる。

## 決定
1. 拡張の `sessionToken`（アプリのシークレットで署名された JWT）を検証し、ショップを特定する。
2. `shopifyOrderId` はクライアントの値を信用せず、Admin API で注文を取得して次を確認する。
   - 手動決済方法「Bitcoinで支払う」の注文であること
   - 支払い待ちの注文であること
3. **不変条件: 請求額は必ずサーバー側で Admin API から取得した値を使う。**
4. 返す情報は最小限にする（checkout link と表示用の状態だけ）。

## 受け入れるリスク
ゲスト購入では、注文と購入者を強く結びつけられない。注文 ID を知っている第三者が支払い状態を見られる可能性は残る。
返す情報を最小限にすることで影響を限定し、このリスクを受け入れる。README の「既知の制限」に記載する。

## 結果
- invoice を作る経路は2つあるが（Webhook と拡張）、どちらも同じユースケースを通り、金額は同じ取得元から得る。

## W2 で決めたこと（2026-10-05、Shopify アダプタ）
- **請求額は `totalOutstandingSet.shopMoney`（未払いの残高、ショップの通貨）を使う**。
  注文の合計ではなく残高を使うので、一部が別の方法で支払われた注文でも、二重に請求しない。
  通貨はショップの通貨（開発ストアは JPY）。BTCPay のレートは `BTC_JPY` だけなので、JPY 以外の注文は invoice の作成で弾く（invoice の作成の実装で行う）。
- 取得する項目は、支払い方法の名前（`paymentGatewayNames`）・`displayFinancialStatus`・`cancelledAt`・残高だけ。
  名前・住所・メール・電話は取らないので、保護された顧客データは **Level 1** で足りる。
  開発ストアでは審査は要らないが、ダッシュボードで申請の手順を済ませる必要がある。

## W2 で決めたこと（2026-10-06、金額の検証）
- 判断は `src/application/order-eligibility.ts` の `checkOrderEligibility` にまとめ、invoice を作る経路（`orders/create`・拡張・孤児回復の作り直し）はすべてここを通す。
  invoice を作れない注文には Payment も作らない（結果は `NOT_ELIGIBLE` と理由）。
- 確認する条件と順番:
  1. `paymentGatewayNames` に「Bitcoinで支払う」を含む（ギフトカードとの併用もありうるので、一致ではなく包含で見る）
  2. キャンセルされていない
  3. `displayFinancialStatus` が `PENDING` か `PARTIALLY_PAID`（一部が別の方法で支払われた注文は残高だけを請求する）
  4. 客に見せた通貨（`presentmentCurrencyCode`）と残高の通貨が、どちらも JPY。
     残高（`shopMoney`）は常にショップの通貨なので、それだけでは客が別の通貨で注文したことを見落とす。このためクエリに `presentmentCurrencyCode` を加えた
  5. 残高が0より大きい
- 孤児回復で作り直す前にも確かめ直す。予約から時間が経つ間に、キャンセルや別の方法での支払いがありうるため。
  確かめ直して作れなかった試行は CREATING のまま残す（既知の制限に記載）。
- 支払い方法の名前「Bitcoinで支払う」はコードの定数で持つ。
  `orders/create` をつないだときに、テスト注文（#1006）で `paymentGatewayNames` が `["Bitcoinで支払う"]`（「Bitcoin」と「で」の間に空白なし）を返すことを確かめた。
  当初はコードと文書に空白ありで書いており、その注文は `NOT_BITCOIN_ORDER` になった。
- 同じ食い違いを繰り返さないよう、**名前は空白と全角・半角の違いを無視して比べる**（NFKC で正規化し、空白を除いてから完全一致）。
  空白以外の文字が違う名前（名前の変更）は一致しない（既知の制限に記載）。

## W2 で決めたこと（2026-10-08、拡張 API）
- ルートは `POST /api/extension/invoice`、ボディは `{ shopifyOrderId }`（コンテキストの `POST /invoice` を、ADR 1 で確かめた `/api/extension/` の下に置いた）。
  処理は `src/application/extension-invoice.ts` の `invoiceForExtension` にまとめ、ルートは認証と組み立てだけにする。
- セッショントークンの `dest` のショップのオフラインセッションで Admin API を呼び、**Payment を読む前に必ず注文を取り直す**。
  Payment にはショップの列がないので、ほかのショップの注文 ID を送られても、このショップの Admin API で見えなければ何も返さない。
  Payment がすでにあれば、注文の支払い状態は問わない（支払い済みになった注文にも「支払い済み」を返す）。
- 返す表示状態は7つ（`PREPARING`・`AWAITING_PAYMENT`・`CONFIRMING`・`PAID`・`EXPIRED`・`CONTACT_SHOP`・`NOT_APPLICABLE`）。
  checkout link を返すのは `AWAITING_PAYMENT` のときだけ。invoice を作れない注文は理由を返さず `NOT_APPLICABLE` にまとめる。
- 注文が Admin API でまだ見えないときは `PREPARING` にする。Thank you ページは注文の作成と同時に表示されるため。
  Payment が CREATING のときも `PREPARING` で、拡張は時間をおいて問い合わせ直す（design.md 5.1 のとおり、拡張は自分では回復しない）。
- checkout link は DB に持たず、支払い待ちのときだけ Greenfield で invoice を取って得る（作った直後は作成の結果を使う）。
  問い合わせのたびに BTCPay を1回呼ぶが、スキーマを変えずに済む。
- 拡張の `orderConfirmation.order.id` は、型の説明では Order の GID。OrderIdentity の GID で届いても同じ数字の Order の GID にそろえる。
  手動の E2E（2026-10-08）で、実際には OrderIdentity の GID で届くことを確かめた（ADR 1）。
- テスト: `tests/application/extension-invoice.test.ts`（DB は本物の SQLite、BTCPay と Shopify はフェイク）、`tests/adapter/shopify/extension-request.test.ts`。
  ルートとセッショントークンの検証は、拡張の UI をつないだ後の手動の E2E で確かめる。

## W3 で変えたこと（2026-10-10、ショップの確かめ方）
- W3 で Payment にショップの列（`shop`）を足した（ADR 8）。拡張 API と再発行は、**Payment があれば、そのショップがセッションのショップと同じかを比べて**確かめる。
  違えば状態を返さず `PREPARING` にする（注文が見えないときと同じ）。上の「Payment を読む前に必ず注文を取り直す」は、この比較に置き換えた。
  拡張は問い合わせを繰り返すので、そのたびに Admin API を呼ばずに済む。
- Payment がなければ、これまでどおり、作成の中でセッションのショップの Admin API で注文を取り直す（見えなければ作らない）。
- ショップは保存と比較の前に表記をそろえる（小文字にし、`https://` と末尾の `/` を除く。`src/adapters/shopify/shop-domain.ts`）。
