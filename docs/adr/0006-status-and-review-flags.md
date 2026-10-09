# ADR 6: 状態と review フラグを分ける

- ステータス: 承認（2026-10-04、ドメインの単体テストで確認。W3 で直列化の部分を追記）
- 日付: 2026-10-01

## コンテキスト
当初は NEEDS_REVIEW を終端の状態の1つにしていた。しかし、PAID の後に古い invoice へ入金される
（二重払い）ように、**終端の後で人の対応が必要になる事象**があり、1本の状態では表せなかった。

## 決定
**status（自動処理がどこまで進んだか）と、ReviewFlag（お金の異常）を直交する2つの軸として持つ。**

### InvoiceAttempt.status
`CREATING → NEW → PROCESSING → SETTLED`、または `EXPIRED` / `INVALID`。
BTCPay の状態をそのまま写したもので、**例外なく前にしか進まない**。

### Payment.status
`CREATING → AWAITING_PAYMENT → CONFIRMING → PAID`、`EXPIRED`（非終端）、`UNRESOLVED`（終端）。
遷移表は [設計ドキュメント 4章](../design.md#4-状態とフラグ) を参照。
再発行（EXPIRED → CREATING）だけはコマンドが起点の遷移で、新しい試行を作ってポインタを付け替える。
どの試行も後ろには戻らない。

### Shopify への反映状況
Shopify への反映状況は status に混ぜず、別の属性 `Payment.shopifySync: PENDING | DONE` として持つ。
status かフラグが変わったら PENDING にし、反映が追いついたら DONE にする（詳細は [ADR 8](0008-inbox-and-idempotent-side-effects.md)）。

### ReviewFlag
- `reason`: UNDERPAID / LATE_PAYMENT / DOUBLE_PAYMENT / INVALID_PAYMENT / OVERPAID
- `UNIQUE(paymentId, reason, attemptId)`。`attemptId` は NOT NULL（NULL を許すとユニーク制約が効かない）。
- `resolvedAt`: 人が対応したら埋める（MVP では手で更新する）。
- Shopify のタグ `btc-review-*` はフラグから導出する。

### 不変条件
1. UNRESOLVED なら、フラグが1つ以上ある。
2. **2つの試行の両方に入金があれば、処理の順番に関係なく DOUBLE_PAYMENT が必ず付く。**
   status は順番によって PAID にも UNRESOLVED にもなりうるが、どちらも人の対応に回るので、この違いは受け入れる。
3. DOUBLE_PAYMENT は**処理が後になった側**の試行に付け、`relatedAttemptId` に相手の試行を入れる。
4. フラグがすべて対応済みなら、その注文は対応完了とみなす。status は変えない。
5. 対応済みのフラグと同じ事象を再検知しても、新しい行はできない。

### 直列化（W3 で追記）
同じ Payment のイベントを2つのワーカーが同時に処理すると、両方が「相手はまだ支払われていない」と判断し、
DOUBLE_PAYMENT を検知できない。そこで、**Payment の `version` 列による楽観ロック**で Payment 単位に直列化する。
競合したら DB を読み直して再判定する。悲観ロック（`SELECT ... FOR UPDATE`）は SQLite に相当する機能がなく、移植性が落ちるので採用しない。

**version は試行だけが変わるときも上げる（2026-10-09、W3 のワーカー）**: design.md 3章は「状態・フラグ・ポインタを変えるたびに +1」としているが、
NEW のままの一部入金のように `paymentDetected` だけが変わる保存でも version を上げる。DOUBLE_PAYMENT の判定はほかの試行の入金（`paymentDetected`）を見るので、
これを上げないと、片方の保存と並行したもう片方の判定が競合として検出されず、不変条件2が破れうる。Shopify への反映待ち（`shopifySync`）にはしない。
invoice の紐づけ（`attachInvoice`）も試行を必ず変えるので、status やフラグが変わらない場合（外から無効化された入金のない invoice を回復で紐づけた場合など）も version を上げる。

## ドメインの実装で判断したこと（2026-10-04）
`src/domain/` の実装中に、design.md 4章に書いていない細部を次のとおり決めた。
- **試行の NEW → INVALID を許す**: 4章の図は INVALID を PROCESSING の下にだけ描いているが、こちらで無効化した未入金の invoice は
  Greenfield で INVALID に見える。これを受け入れないと試行が NEW のまま残り、スイープが無効化を繰り返す。
- **途中を飛ばす遷移を許す**: Webhook を取りこぼすと途中の状態を見ないので、試行も Payment も「遷移表で前に到達できるなら進める」とした。
  Payment は遷移表のイベント起点の辺だけで判定し、EXPIRED → CREATING（再発行）は `reissue()` だけが行う。
- **入金の有無は導出する**: 試行に「入金あり」の列は持たず、試行の状態（PROCESSING・SETTLED）か、その試行に付いた
  UNDERPAID / LATE_PAYMENT / DOUBLE_PAYMENT / OVERPAID のフラグから導出する。INVALID_PAYMENT は入金が取り消されたので含めない。
- **DOUBLE_PAYMENT の「後」**: 入金を初めて検知した時点で、ほかの試行に入金があれば、検知した側に付ける。
  一度入金を記録した試行を再処理しても付けないので、どの順番でもちょうど1件になる。
- **BTCPay の状態はアダプタで変換する**: ドメインは `InvoiceObservation`（試行の状態と、入金の様子 NONE / PARTIAL / FULL / OVER / LATE）だけを受け取る。
  BTCPay の additionalStatus からの変換は W2 のアダプタで行う。支払い方法に依存しないので、Lightning を足しても形は変わらない（ADR 2）。
- 単体テスト（`tests/unit/domain/`）: 試行と Payment の全組（前に進む組と、無効な組）、4章の表の各行、
  1つの試行に観測を3回当てる全組み合わせ（25³通り）と、再発行後の2つの試行への全組み合わせで不変条件1・2・5を確認した。
  二重払いはすべての処理順で DOUBLE_PAYMENT がちょうど1件になり、status は順番によって PAID か UNRESOLVED になる。
  逆向きも確認した。片方にしか入金がないのに DOUBLE_PAYMENT が残るのは、相手の入金が後から取り消された（INVALID_PAYMENT）場合だけで、
  そのとき status は UNRESOLVED になる。フラグは事象の記録なので、取り消されても消さない。
  `src/domain/` が domain の外を import しないこと（ADR 3）もテストで確認している。

## 一部入金を試行の列に残す（2026-10-05、コードレビューで判明）
上の「入金の有無は導出する」を一部改め、試行に `paymentDetected`（この試行で入金を観測したか）を持つ。
- **理由**: NEW のままの一部入金（NEW・PARTIAL）は、試行の状態にもフラグにも残らない。再発行した a2 に一部入金があった後に
  古い a1 への期限後の入金を処理すると、a2 を「未入金」とみなして LATE_PAYMENT だけを付け、一部入金のある a2 の invoice を無効化していた。
  DOUBLE_PAYMENT が付かず、不変条件2が破れる。
- **決定**: `applyObservation` が入金を観測したら `paymentDetected` を立てる。`hasPayment` は、従来の導出に加えてこの列を見る。
  ただし INVALID になった試行の入金は、従来どおり取り消されたものとして数えない（フラグに残った入金は数える）。
  一部入金のあとに外から Invalid になった試行は、これで INVALID_PAYMENT を付けて人の対応に回る。
- 結果の `attemptStatusChanged` は `attemptChanged` に改め、`paymentDetected` が変わったときも true にする（試行の行の保存が必要なため）。
- **テスト**: 不変条件2の網羅テストは、入金の有無を `hasPayment` で判定していたので、この見落としを検出できなかった。
  当てた観測から独立に判定する検査を足し、修正前のコードで失敗することを確かめた。

## BTCPay の状態の変換（2026-10-05、W2 のアダプタ）
`src/adapters/btcpay/invoice-observation.ts` で、Greenfield の `status` / `additionalStatus` を `InvoiceObservation` に変換する。
- status はそのまま写す（New → NEW など）。`additionalStatus` は PaidPartial → PARTIAL、PaidOver → OVER、PaidLate → LATE。
- Processing と Settled は全額が届いているので、過払いでなければ FULL とする。
- Marked（管理画面で手動で変えた）と Invalid は入金の様子を表さないので NONE とする。管理画面で手で状態を変えない前提は、design.md 9章の既知の制限に書いた。
- 知らない値は推測で変換せず、例外にする（inbox の再処理に任せる）。
- regtest で、全額 → PROCESSING・FULL → 1ブロックで SETTLED・FULL、過払い → PROCESSING・OVER、一部入金 → NEW・PARTIAL を確認した。
  期限切れ（PARTIAL・LATE）と INVALID は W3 のシナリオ 2〜4 と ADR 9 の未検証事項で確認する。
  特に、入金のある invoice が Invalid になったとき `additionalStatus` から入金の有無が読めない場合は、支払い額の取得を足す必要がある。

## 検討した代替案
- **UNRESOLVED から PAID への遷移を許して、結果を揃える**: UNRESOLVED が終端でなくなり、状態機械が複雑になる。
- **OVERPAID をフラグではなく情報として記録するだけにする**: フラグの種類を1つに統一したほうが単純なので、フラグに入れた。

## 結果
- PAID の後に起きる異常（DOUBLE_PAYMENT）を、状態を壊さずに記録できる。reorg による INVALID_PAYMENT も同じ形で記録できるが、MVP では実装しない（SETTLED を終端にしている。design.md 9章）。
- テスト: 単体テストで全遷移を検証する。シナリオ9（二重払いを並列に処理してもフラグがちょうど1件）。
