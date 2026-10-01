# ADR 6: 状態と review フラグを分ける

- ステータス: 提案（下書き。W1 の実装時に確定。W3 で直列化の部分を追記）
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

## 検討した代替案
- **UNRESOLVED から PAID への遷移を許して、結果を揃える**: UNRESOLVED が終端でなくなり、状態機械が複雑になる。
- **OVERPAID をフラグではなく情報として記録するだけにする**: フラグの種類を1つに統一したほうが単純なので、フラグに入れた。

## 結果
- PAID の後に起きる異常（DOUBLE_PAYMENT、reorg による INVALID_PAYMENT）を、状態を壊さずに記録できる。
- テスト: 単体テストで全遷移を検証する。シナリオ9（二重払いを並列に処理してもフラグがちょうど1件）。
