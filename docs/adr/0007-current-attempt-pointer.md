# ADR 7: 有効な試行をポインタで保証する

- ステータス: 承認（2026-10-02、W1 ② の Prisma の検証で実現できることを確認）
- 日付: 2026-10-01

## コンテキスト
再発行があるので、Payment と InvoiceAttempt は 1:N になる。
「有効な試行は1つの Payment につき最大1件」を DB で保証したい。

## 決定
**`Payment.currentAttemptId`（UNIQUE、NULL 可）というポインタを持ち、「有効な試行 = Payment が指している試行」と定義する。**
- 試行に `active` 列を持たないので、「有効な試行が2件ある」状態をそもそも表現できない。
- 別の Payment の試行を指せないように、**複合外部キー**を使う。
  `InvoiceAttempt @@unique([id, paymentId])` を作り、Payment から `(currentAttemptId, id)` → `(id, paymentId)` で参照する。
- 作成順序: Payment（ポインタは NULL）→ 試行 → ポインタ設定。ここまでを1つのトランザクションで行う。
  複合外部キーは既定の MATCH SIMPLE なので、ポインタが NULL の間は検査されない。commit の後はポインタが NULL にならない。

## 検討した代替案
- **部分ユニークインデックス**（`... ON InvoiceAttempt(paymentId) WHERE active = 1`）: Prisma のスキーマでは表現できず、
  手書きのマイグレーションが必要になる。Prisma がこのインデックスを知らないので、ドリフト検知で揉める恐れがある。
  「制約で守る」よりも「不正な状態を表現できない構造にする」ほうが強いので、見送った。

## W1 ② の検証結果（2026-10-02、Prisma 6.19.3 + SQLite）
複合外部キーの方式で実現できたので、リポジトリ層で検査する方式には切り替えない。
- `prisma validate` と `prisma migrate dev` が通り、マイグレーションに
  `FOREIGN KEY ("currentAttemptId", "id") REFERENCES "InvoiceAttempt" ("id", "paymentId")` が入った。
- Prisma は1対1のリレーションの参照元に UNIQUE を要求するので、`Payment @@unique([currentAttemptId, id])` を足した。
  `currentAttemptId` が単独で UNIQUE なので意味は変わらない（冗長なインデックスが1つ増えるだけ）。
- 参照動作は両方の外部キーとも `onDelete: Restrict, onUpdate: Restrict` にした。Prisma の既定（NULL 可のリレーションは SetNull）だと、
  NOT NULL の `id` を含む複合外部キーに NULL を入れようとしてしまうため。
- `tests/adapter/db/current-attempt-pointer.test.ts` の3本が通った。
  - ポインタが NULL の Payment は作れる
  - Payment → 試行 → ポインタの設定を、1つのトランザクションで行える
  - 別の Payment の試行を指すと、外部キー違反（P2003）で失敗する。Prisma の接続で `PRAGMA foreign_keys` が 1 になっていることも確かめた

## スキーマの本実装で判断したこと（2026-10-04）
design.md 3章に書いていない細部を、実装中に次のとおり決めた。
- **フラグも同じ方式で守る**: ReviewFlag の `(attemptId, paymentId)` と `(relatedAttemptId, paymentId)` から
  InvoiceAttempt `(id, paymentId)` を複合外部キーで参照し、別の Payment の試行を指すフラグを作れないようにした。
  `relatedAttemptId` が NULL の間は MATCH SIMPLE により検査されない。
- **主キーとタイムスタンプを足した**: ReviewFlag と Inbox に `id`、Payment と InvoiceAttempt に `createdAt` / `updatedAt`、
  Inbox に `receivedAt` / `updatedAt`。スイープの孤児回復（design.md 5.5 の 1）は、試行の `createdAt` で「一定時間が経った」を判定する。
- **`shopifySync` の既定値は DONE**: 作成時点では Shopify に反映するものがない。status かフラグを変えるときだけ PENDING にする。
- **`btcpayInvoiceId` は UNIQUE**: 同じ invoice を2つの試行に紐づけられないようにする（CREATING の間の NULL は重複してよい）。
- **状態の値は Prisma の enum**: SQLite では TEXT として保存され、値の検査は Prisma Client が行う（DB に CHECK 制約はない）。
  CHECK 制約を足すには手書きのマイグレーションが要るので、部分ユニークインデックスと同じ理由で見送った。
- `tests/adapter/db/review-flag-and-inbox.test.ts` で、フラグの複合外部キー違反（P2003）、
  不変条件5のユニーク制約、Inbox の `(source, eventId)` の重複（P2002）が失敗することを確かめた。

## 結果
- 再発行は、同じトランザクションの中でポインタを付け替えるだけで済む。
- Postgres に移行しても同じ形のまま使える。

## 予約の実装で判断したこと（2026-10-06）
- **SQLite への接続を1本にした**（`schema.prisma` の `url` に `connection_limit=1`）。予約のトランザクションを10並列で流すと、
  ロック待ちの接続がロックを持つ側の次のクエリまで止め、`busy_timeout`（5秒）で9件が失敗した。1本にすると、トランザクションは Prisma の中で順番に流れ、
  10並列でも約 15ms で終わる。読み取りも直列になるが、このアプリの量では問題にならない。テスト用の DB（`tests/helpers/test-db.ts`）も同じ設定にした。
- invoice の紐づけのトランザクションは、**最初に書き込み**（試行の条件付き更新）をしてから読む。読み取りから始めると、書き込みに切り替えるときに
  `busy_timeout` を待たずに失敗することがあるため。接続が1本の間は起きないが、接続数に依存しない書き方にしておく。
