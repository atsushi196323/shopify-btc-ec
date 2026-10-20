# 設計ドキュメント: Shopify × BTCPay Server（regtest）Bitcoin 決済

- ステータス: 設計確定（実装前の下書き）
- 最終更新: 2026-10-01
- 関連: [ADR 一覧](#adr-一覧)

## 1. 目的とスコープ

### 目的
就職活動用のポートフォリオとして、Web 系自社開発企業（バックエンド寄り）の採用担当に
**決済システムの設計力と実装力**が伝わる成果物を作る。

### スコープ
- 自分の Shopify 開発ストアで動かすカスタムアプリ（公開アプリにはしない）
- BTCPay Server を Mac 上の regtest で動かす（実際のお金は扱わない）
- 公式プラグインを使わず、**invoice 発行 → Webhook → 注文更新**を自作する
- 言語は TypeScript

### 対象外（README に考慮点を書くだけ）
- 本番運用、法規制、換金、税務
- PAID の後に入金が無効化される reorg（方針は [ADR 9](adr/0009-payment-confirmation-and-anomaly-policy.md) に書き、テストは stretch）
- 返金処理（フラグで人の対応に回す）

### 設計の凍結
予備時間がほぼないため、**この文書の時点で設計の追加を止める**。
これ以降に見つかった論点は、次のいずれかで扱う。
1. 実装中に判断し、その週の ADR に短く記録する
2. README の「既知の制限」に書く
3. stretch に回す

## 2. 全体構成

```
[購入者] ──checkout──▶ [Shopify]  ──orders/create──▶ ┐
   │                     ▲                            │
   │ Thank you /         │ orderMarkAsPaid / タグ      ▼
   │ 注文状況ページ拡張   │                        [shop-app]  ◀──Webhook── [BTCPay Server]
   └──sessionToken──────────────────────────────▶  (React Router)  ──Greenfield API──▶  │
                                                       │                               │
                                                    [SQLite]               [NBXplorer]─[bitcoind regtest]
```

- **Shopify への組み込み**: 手動決済方法「Bitcoinで支払う」。注文は支払い待ちのまま確定し、
  Thank you / 注文状況ページの Checkout UI Extension で支払いへ誘導する（[ADR 1](adr/0001-checkout-integration.md)）。
- **支払い方法**: オンチェーンのみ。Lightning は stretch（[ADR 2](adr/0002-onchain-first.md)）。
- **アプリの構成**: Shopify CLI テンプレート（React Router）1つ。中身は
  フレームワークに依存しない `domain / application / adapters` に分ける（[ADR 3](adr/0003-single-app-ports-and-adapters.md)）。
- **通貨**: JPY。BTCPay の rate rules で `BTC_JPY` を固定値にする（[ADR 10](adr/0010-deterministic-testing.md)）。

### リポジトリ構成

```
apps/shop-app/                # Shopify テンプレート（React Router）
  app/routes/                 # Webhook 受信・拡張 API・管理画面（薄く保つ）
  src/domain/                 # 状態機械・フラグ・不変条件（依存ゼロ）
  src/application/            # ユースケース（invoice 作成・イベント処理・再発行・スイープ）
  src/adapters/{btcpay,shopify,db}/
  src/adapters/shopify-fake/  # CI 用
  extensions/thank-you/       # Checkout UI Extension
infra/regtest/                # 最小 compose・固定レート・ブロック生成スクリプト
tests/{unit,adapter,integration}/
docs/adr/  docs/diagrams/
```

### ローカル環境
- BTCPay の最小 compose（bitcoind・NBXplorer・BTCPay・Postgres）を `infra/regtest/` に置く。
  - BTCPayServer.Tests の compose には BTCPay 本体が含まれない（依存サービスだけ）。そのため、
    **BTCPay の `v2.4.4` タグ時点の Tests の compose から bitcoind・NBXplorer・Postgres の定義を写し、
    `btcpayserver/btcpayserver:2.4.4` を足す**形を最初から使う。4つのイメージはすべて arm64 版がある。
  - W1 で5時間を上限に検証する。届かなければ段階的に引き上げる（8章の W1 計画）。
- `shopify.web.toml` に `port = 3000` を書き、アプリのポートを固定する。
  - Shopify → アプリ: Shopify CLI のトンネル経由
  - BTCPay → アプリ: `http://host.docker.internal:3000/webhooks/btcpay`
  - `--use-localhost` は使わない（Shopify から Webhook が届かなくなるため）

## 3. データモデル

```
Payment
  id
  shop               注文のショップ（xxx.myshopify.com）。Shopify への反映に使う（ADR 8）
  shopifyOrderId     UNIQUE
  status             CREATING | AWAITING_PAYMENT | CONFIRMING | PAID | EXPIRED | UNRESOLVED
  version            楽観ロック用（状態・フラグ・ポインタを変えるたびに +1）
  currentAttemptId   UNIQUE, NULL 可
  (currentAttemptId, id) → InvoiceAttempt(id, paymentId)   複合外部キー
  shopifySync        PENDING | DONE（Shopify への反映状況。ドメインの状態とは別の属性）
  shopifySyncError   NULL 可（最後の反映失敗の内容）

InvoiceAttempt
  id                 BTCPay の invoice の orderId 欄にも入れる（試行単位の冪等性キー）
  paymentId          → Payment
  btcpayInvoiceId    NULL 可（CREATING の間）
  status             CREATING | NEW | PROCESSING | SETTLED | EXPIRED | INVALID
  invalidatedByUs    boolean
  invalidatedAt      NULL 可
  paymentDetected    boolean（この試行で入金を観測したか。NEW のままの一部入金を残すため。ADR 6）
  @@unique([id, paymentId])

ReviewFlag
  paymentId
  reason             UNDERPAID | LATE_PAYMENT | DOUBLE_PAYMENT | INVALID_PAYMENT | OVERPAID
  attemptId          NOT NULL
  relatedAttemptId   NULL 可（DOUBLE_PAYMENT のときの相手の試行）
  detectedAt
  resolvedAt         NULL 可（人が対応したら手で埋める）
  UNIQUE (paymentId, reason, attemptId)

Inbox
  source             BTCPAY（MVP。SHOPIFY は stretch で追加）
  eventId            UNIQUE（source と組で）
  payload
  status             PENDING | DONE | FAILED
  attempts
  lastError
```

**命名の約束**: アプリ内では Shopify の注文 ID を常に `shopifyOrderId` と呼ぶ（DB の列、API の引数、BTCPay のメタデータのいずれも）。
`orderId` と書くのは **BTCPay の invoice の `orderId` 欄**（ここには attemptId を入れる）だけ。

### 作成の順序と不変条件
- Payment と試行は互いを参照する。作成は次の順で、**1つのトランザクションで**行う。
  1. Payment を作る（`currentAttemptId = NULL`）
  2. InvoiceAttempt を CREATING で作る
  3. ポインタを設定する
- 複合外部キーは既定の MATCH SIMPLE なので、参照元の列が NULL の間は検査されない。
- **commit の後はポインタが NULL にならない**（外からは見えない）。
- BTCPay の呼び出しは commit の後に行う。
- 「有効な試行は最大1件」は、ポインタという構造で保証する（[ADR 7](adr/0007-current-attempt-pointer.md)）。
- SQLite の設定: WAL、`busy_timeout`、`foreign_keys = ON`。外部キーが効いていることを、
  違反を起こすテストで確認する。

## 4. 状態とフラグ

状態（status）とフラグ（reviewFlags）は別の軸として持つ（[ADR 6](adr/0006-status-and-review-flags.md)）。
- **status**: 自動処理がどこまで進んだか
- **flags**: お金に関する異常。人が対応すべき事情を漏れなく記録する

### InvoiceAttempt.status（例外なく前にしか進まない）
BTCPay の invoice の状態をそのまま写したもの。

```
CREATING → NEW → PROCESSING → SETTLED
             │        │
             ▼        ▼
          EXPIRED   INVALID
```

Greenfield で取り直した状態が古くても、遷移が前にしか進まないので害にならない
（無効な遷移は何もしない no-op になる）。

### Payment.status の遷移表

| 遷移 | きっかけ |
|---|---|
| CREATING → AWAITING_PAYMENT | 現在の試行が NEW |
| AWAITING_PAYMENT → CONFIRMING → PAID | 現在の試行が PROCESSING → SETTLED |
| AWAITING_PAYMENT → EXPIRED | 現在の試行が入金なしで期限切れ |
| EXPIRED → CREATING | **再発行**（新しい試行を作り、ポインタを付け替える。唯一のコマンド起点の遷移） |
| CONFIRMING → UNRESOLVED | 現在の試行が INVALID（フラグは INVALID_PAYMENT） |
| EXPIRED → UNRESOLVED | 一部入金のまま期限切れ（UNDERPAID）、または期限後の入金（LATE_PAYMENT） |
| AWAITING_PAYMENT → UNRESOLVED | 古い試行に期限後の入金があり、新しい試行は未入金（LATE_PAYMENT。新しい invoice は無効化する） |

- 終端は `PAID` と `UNRESOLVED`。
- 再発行は「EXPIRED に戻る」のではなく、新しい試行を作る操作。どの試行も後ろには戻らない。

### 古い試行に期限後の入金があったとき

| 新しい試行の状態 | 処理 |
|---|---|
| 未入金（Payment が AWAITING_PAYMENT で、一部入金もない） | 新しい invoice を Greenfield で無効化（`invalidatedByUs = true`）し、Payment を UNRESOLVED にする。フラグは LATE_PAYMENT |
| 入金済みで承認待ち（CONFIRMING） | 無効化しない。DOUBLE_PAYMENT を付け、Settled になったら PAID |
| PAID | DOUBLE_PAYMENT を付ける |

### 不変条件
1. UNRESOLVED なら、ReviewFlag が1つ以上ある。
2. **2つの試行の両方に入金があれば、処理の順番に関係なく DOUBLE_PAYMENT が必ず付く。**
   status は順番によって PAID にも UNRESOLVED にもなりうるが、どちらも人の対応に回るので、この違いは受け入れる。
3. DOUBLE_PAYMENT は**処理が後になった側**の試行に付け、`relatedAttemptId` に相手の試行を入れる。
   「後」はチェーン上の時刻ではなく、Payment 単位で直列化された処理の順番で決まる。
4. フラグがすべて対応済み（`resolvedAt` あり）なら、その注文は対応完了とみなす。status は変えない。
5. 対応済みのフラグと同じ事象を再検知しても、ユニーク制約により新しい行はできない（対応済みのまま）。

### Shopify への反映（`shopifySync`）
反映は「遷移が起きた瞬間に1回だけ呼ぶ」のではなく、**`shopifySync` という属性で反映待ちを記録し、追いつくまで繰り返す**。
遷移の瞬間だけを起点にすると、反映に失敗した後の再処理では遷移が no-op になり、二度と反映されないため。

1. **PENDING にする**: Payment の status かフラグが変わるトランザクションの中で、`shopifySync = PENDING` にする（`version` も +1 される）。
2. **反映する**（commit の後）: Payment を読み、次を冪等に行う。
   - status が PAID なら `orderMarkAsPaid`。呼ぶ前に `displayFinancialStatus` を確認し、すでに PAID ならスキップする。
   - 未対応のフラグから導出したタグ `btc-review-<reason>` を付ける（`tagsAdd` は付いているタグに対しては何もしない）。
3. **DONE にする**: `WHERE version = <読んだときの version>` 付きで `shopifySync = DONE` にする。
   反映中に別の変更が入っていたら更新は0件になり、PENDING のまま残る。こうすれば、新しい変更を反映し損ねたまま DONE になることはない。
4. **失敗したら**: PENDING のまま `shopifySyncError` に内容を記録し、スイープに任せる。

- 反映処理を呼ぶきっかけは2つある。イベント処理の commit 直後と、スイープ（5.5 の 6）。
- MVP では、フラグを対応済みにしてもタグは手で外す。フラグからタグを再計算して外す同期処理は stretch。

## 5. フロー

### 5.1 invoice の作成（初回）
1. 起点は2つある。`orders/create` Webhook、または拡張からの問い合わせ（その時点で未作成なら作る）。
2. Admin API で注文を取得し、支払い方法・状態・**請求額**を確認する（[ADR 4](adr/0004-server-side-amount-and-guest-risk.md)）。
3. 予約: 1つのトランザクションで Payment・試行・ポインタを作る。`shopifyOrderId` が UNIQUE なので、競合したら負けた側は既存の行を読んで返す。
4. commit の後、BTCPay に invoice を作る。`orderId` 欄には **attemptId** を入れ、`shopifyOrderId` はメタデータに入れる。
5. 試行に `btcpayInvoiceId` を保存し、状態を NEW にする。Payment は AWAITING_PAYMENT になる。

`orders/create` は MVP では inbox を通さず、Webhook のリクエストの中で上の手順を直接実行する。
- BTCPay の呼び出しが遅く、Shopify の Webhook がタイムアウトして再送された場合は、再送されたリクエストが手順3で `shopifyOrderId` の UNIQUE に負ける。既存の行を読んで 200 を返すので、重複は起きない。
- 最初のリクエストの処理は、接続が切れても続く。途中でプロセスが落ちて試行が CREATING のまま残った場合は、**スイープの孤児回復（5.5 の 1）が回復する**。
- 拡張の遅延作成が担うのは「Payment がまだない」場合だけ。Payment が CREATING なら、拡張は作成を待ってリトライする（自分では回復しない）。

詳細は [ADR 5](adr/0005-invoice-creation-dedup-and-orphan-recovery.md)。

### 5.2 拡張 API
- `sessionToken`（JWT）を検証し、ショップを特定する。
- クライアントから受け取った `shopifyOrderId` は信用せず、Admin API で注文を取得し直して確認する。
- 返すのは checkout link と表示用の状態だけ。
  - 表示状態の例: 支払い待ち / 入金確認中 / 支払い済み / 期限切れ（再発行可） / ショップから連絡します

### 5.3 BTCPay Webhook の処理
1. `BTCPay-Sig`（HMAC-SHA256）を検証する。
2. Inbox に保存し（イベント ID は UNIQUE）、すぐに 200 を返す。
3. ワーカー（同じアプリ内の簡易版）が処理する。
   1. **トランザクションの外で** Greenfield から invoice の最新状態を取り直す（ペイロードは信用しない）。
   2. Payment を読み、ドメインで遷移とフラグを判定する。
   3. `version` 付きで更新する。競合したら DB を読み直して再判定する（上限回数あり）。Greenfield の再取得はしない。
   4. 上限に達したら inbox の行を PENDING のまま残し、次回のワーカーかスイープに任せる。
   5. 再処理の合計回数が上限（例: 10回）を超えたら FAILED にする。
4. 更新の commit で inbox の行を DONE にする。Shopify への反映は `shopifySync` が担う（4章）。commit の直後に反映処理を1回呼び、失敗してもスイープが追いつかせる。

詳細は [ADR 8](adr/0008-inbox-and-idempotent-side-effects.md)。

Shopify の Webhook（`orders/create`）は、MVP では inbox を通さない（5.1）。`X-Shopify-Hmac-Sha256` の検証はテンプレートの仕組みで行う。
冪等性は `Payment.shopifyOrderId` の UNIQUE で担保する。`X-Shopify-Event-Id` で重複を除く inbox を通す形への厳密化は stretch。

### 5.4 再発行
- 起点は拡張の「invoice を再発行」ボタン。Payment が EXPIRED のときだけ受け付ける。
- 1つのトランザクションで、新しい試行を CREATING で作り、ポインタを付け替え、Payment を CREATING にする（`version` 付き）。
- commit の後に BTCPay を呼ぶ（5.1 の 4 以降と同じ）。

### 5.5 スイープ（定期実行）
1本のジョブで、次のすべてを担う。
1. **孤児の回復**: CREATING のまま一定時間が経った試行を `GET invoices?orderId=<attemptId>` で検索する。見つかれば紐づけ、なければ作成を再試行する。初回の作成と再発行で同じ処理を使う。
2. **照合**: 終端でない試行と、期限切れから一定期間（設定値）の EXPIRED の試行の状態を Greenfield から取り直し、5.3 と同じ処理を通す。
   EXPIRED の試行も見るのは、取りこぼした期限後の入金を拾うため（[ADR 8](adr/0008-inbox-and-idempotent-side-effects.md)、2026-10-19）。
3. **無効化のリトライ**: Payment が UNRESOLVED なのに現在の試行が NEW なら、無効化する。
4. **無効化した試行の監視**: `invalidatedByUs` の試行を、無効化から一定期間（設定値）照合する。入金があれば DOUBLE_PAYMENT を付ける。
5. **inbox の再処理**: PENDING の行を処理する。
6. **Shopify への反映**: `shopifySync = PENDING` の Payment について、4章の反映処理を行う。

## 6. 支払い済みとする条件と異常系のポリシー

[ADR 9](adr/0009-payment-confirmation-and-anomaly-policy.md) の要約です。

| 事象 | 扱い |
|---|---|
| 入金を検知（Processing） | 拡張に「入金確認中」と表示する |
| Settled（承認数は設定値、既定は 1 conf） | PAID にし、`orderMarkAsPaid` を呼ぶ |
| 入金なしで期限切れ | EXPIRED。再発行できる（レートを取り直す） |
| 一部入金のまま期限切れ（支払い許容誤差は 0%） | UNRESOLVED + UNDERPAID |
| 過払い | PAID + OVERPAID |
| 期限後の入金 | 自動では支払い済みにしない。UNRESOLVED + LATE_PAYMENT |
| CONFIRMING の間に Invalid（二重支払い・RBF） | UNRESOLVED + INVALID_PAYMENT |
| 古い試行と新しい試行の両方に入金 | DOUBLE_PAYMENT（4章の表に従う） |
| PAID の後に Invalid（reorg） | 方針: PAID のまま INVALID_PAYMENT を付ける。MVP の実装では何もしない（SETTLED を終端にしている）。実装とテストは stretch |
| 注文の自動キャンセル | stretch |

## 7. テスト戦略

| 層 | 対象 | 依存 |
|---|---|---|
| 単体 | ドメインの全遷移と不正な遷移、フラグ、不変条件 | なし |
| アダプタ | BTCPay の署名検証（既知のベクタ）、Shopify の GraphQL を保存した Admin API のスキーマで検証（ADR 10） | なし |
| 統合 | 下の9シナリオ | 本物の BTCPay と bitcoind（regtest）、フェイクの Shopify |

- 統合テストは**テストプロセスの中でアプリを組み立てる**。compose に入れるのは依存サービスだけ。
- 遅延や例外の注入は、BTCPay アダプタを包む**テスト用デコレータ**でテスト側から差し込む。本番コードには分岐を入れない。
- CI（Linux）では `extra_hosts: host.docker.internal:host-gateway` を使う。
- アプリ全体を起動して確かめる検証は、手動の E2E とデモ動画が担う。

### 統合テストのシナリオ
1. 正常系（入金 → 1ブロック生成 → PAID）
2. 期限切れ → 再発行 → 支払い（古い invoice への期限後の入金で、新しい invoice が無効化されることも確認する）
3. 過少払いのまま期限切れ → UNRESOLVED + UNDERPAID
4. 過払い → PAID + OVERPAID
5. 同じ Webhook を再送しても、Shopify の呼び出しは1回
6. Webhook を遮断しても、スイープで PAID に収束する
7. invoice 作成の競合（Webhook と拡張をそれぞれ10並列で送り、DB の Payment と BTCPay の invoice がどちらも1件）
8. クラッシュからの回復（初回の作成と再発行の両方。BTCPay で作成した後、DB の更新前に例外を注入する）
9. 二重払いを並列に処理しても、DOUBLE_PAYMENT フラグがちょうど1件付く

## 8. 計画

- 作業時間: 週15時間（時間帯は自由に配置する）。下振れ時は週10時間。予定より早く進んだ分は予備が増えたものとして扱う。
- MVP（W1〜W4）: 10/1〜10/28。予備: 10/29〜11/11。**完成目標は11月中旬**。その後に stretch に取り組む。
- ADR は、実装したその週に1件あたり約15分で書く。

| 週 | タスク | ADR | 確認項目 |
|---|---|---|---|
| W1 | compose の検証（5時間で区切る）、`shopify app init`、Prisma の検証（1.5時間で区切る）、ポート固定・手動決済方法、Prisma スキーマ、ドメインと単体テスト | 2, 3, 6, 7, 10 | Prisma で複合外部キーが書けるか、`foreign_keys` が有効か |
| W2 | bootstrap スクリプト化の残り、BTCPay の Webhook 送信先をアプリ本体に置き換え、invoice 作成（予約行・孤児検索）、拡張、金額の検証、デコレータとシナリオ7 | 1, 4, 5 | BTCPay の支払い画面に `orderId` が表示されるか |
| W3 | BTCPay Webhook・inbox・ワーカー、Shopify への反映、異常系・再発行、シナリオ1〜5・9 | 8, 9 | 無効化した invoice に入金したときの BTCPay の挙動 |
| W4 | スイープ、シナリオ6・8、GitHub Actions、README・図、デモ動画 | 見直し | |

### W1 の詳細計画（10/1〜10/7、合計15時間）

| 日 | 作業 | 時間 |
|---|---|---|
| 10/1（木）〜10/2（金） | compose の検証。手作業で完了ラインまで通す | 5h |
| 10/3（土）〜10/4（日） | ① `shopify app init` 0.5h → ② Prisma の検証 1.5h → ③ ポート固定（`port = 3000`）と手動決済方法の作成 1.5h → ④ bootstrap スクリプト化 0.5h（残りは W2 の最初に回す） | 4h |
| 10/5（月）〜10/7（水） | Prisma スキーマの本実装 2h / ドメイン（状態機械・フラグ・不変条件）の単体テスト 4h | 6h |

**compose の検証の完了ライン**（手作業で通れば完了。スクリプト化は別の作業として扱い、構成の切り替え判断の対象にはしない）
1. 全コンテナが正常に起動し、BTCPay の管理画面が開ける。NBXplorer の同期が完了している（1.5h の確認地点）
2. ストアと regtest のウォレットを作り、`BTC_JPY` の固定レートで JPY 建ての invoice を作れる。Speed Policy は 1 conf、期限は短く設定する（3h の確認地点）
3. `bitcoin-cli` で支払い、ブロックを生成すると Settled になる
4. `host.docker.internal:3000` の仮エンドポイント（Node の `http` で書いた20行程度のサーバー）で Webhook を受け取り、`BTCPay-Sig` ヘッダと生のボディをログに出せる。
   **この仮エンドポイントは W1 の検証専用**。アプリ本体も port 3000 を使うので、W2 以降は BTCPay の Webhook 送信先をアプリ本体のエンドポイント（`/webhooks/btcpay`）に置き換え、仮エンドポイントは使わない
5. `docker compose down -v` で全部消してから立ち上げ直しても、同じ手順で再現できる（5h の確認地点）

**5時間で届かなかった場合**
1. 予備から +2h 借りる。延長するのは、詰まっている段階の解決だけ
2. それでも届かなければ、BTCPay の本体を v2.4.4 のソースからホストで `dotnet run` する（上限 3h）。CI で `setup-dotnet` とビルドが必要になる点を W4 の欄に書いておく
3. 合計で10時間を使った時点で作業を止め、計画を立て直す

**compose が延びた場合に後ろへずらす順番**
- 週末の ① init と ② Prisma の検証は、必ずこの順で先に行う（Prisma の検証はテンプレートのスキーマの上で行うため）
- 時間が押した場合は、④ スクリプト化 → ③ ポート固定・手動決済方法 → スキーマ本実装の一部、の順に W2 へ送る
- ドメインの単体テスト（4h）は W1 に残す

**Prisma の検証**（1.5h で区切る）: 循環参照する複合外部キーについて、`prisma validate` と `migrate dev` が通ること、
生成された SQL に外部キーの定義が入っていること、3本のテスト（違反は失敗する／NULL のポインタは作れる／1つのトランザクションで作成できる）が通ることを確認する。
1つでも通らなければ、リポジトリ層で検査する方式に切り替えて ADR 7 に記録する。

**ADR を書くタイミング**: ADR 10 は compose の検証を終えた日、ADR 3 は雛形を作った日、ADR 7 は Prisma の検証を終えた日、ADR 2・6 は単体テストを書き終えた日。

### 進捗と調整
- **進捗確認**: 10/14（W2 の終わり）に、累計28時間分の作業が終わっているか確認する。
- **遅れたときに削る順番**:
  1. デモ動画を GIF とスクリーンショットに変える
  2. 拡張の UI を最小限にする
  3. 再発行を MVP から外す（シナリオ2 は stretch へ）
  4. シナリオ3・4 を単体テストだけにする
  5. 予備期間を使う
- **stretch の優先順**:
  1. outbox の本実装
  2. Shopify Webhook も inbox を通し、`X-Shopify-Event-Id` で重複を除く（MVP は `shopifyOrderId` の UNIQUE だけで冪等性を担保）
  3. 注文の自動キャンセル
  4. Lightning
  5. 構造化ログとメトリクス
  6. 管理画面の要対応一覧（2026-10-20 追加）: 未対応のフラグがある注文の一覧と詳細（試行・BTCPay の invoice・届いたイベント）、
     「対応済みにする」操作（`resolvedAt` を埋め、フラグからタグを再計算して同期する）、止まっている処理（inbox の FAILED・反映待ちが続く Payment）の件数
  7. その他: reorg の実装とテスト、テンプレートの codegen の修正（ADR 10）、CI のランナーの Ubuntu 26 への移行（ADR 10）、
     ドメインのミューテーションテスト（Stryker。2026-10-20 追加）

## 9. 既知の制限（README に転記する）
- ゲスト購入では、注文と購入者を強く結びつけられない。拡張 API が返す情報を最小限にすることで、このリスクを受け入れる。
- 返金・換金・税務・法規制は扱わない。異常はフラグとタグで人の対応に回す。
- 固定レートで動かしている。本番ではレートの取得元とレートの有効期限を設計する必要がある。
- 承認数は既定で 1 conf。本番では金額に応じて承認数を変えることを検討する。
- 無効化した試行を監視する期間は regtest 用に短くしている。本番では、未承認の取引がネットワークに伝わる時間を考えて長めに取る。
- 二重払いのとき、status は処理の順番によって PAID にも UNRESOLVED にもなる（DOUBLE_PAYMENT フラグは必ず付く）。
- MVP ではフラグを対応済みにしてもタグは自動で外れない。
- ワーカーは同じアプリ内の簡易版で、水平スケールは考慮していない。
- BTCPay の管理画面などで、入金のない現在の invoice をアプリの外から無効化すると、試行は INVALID（終端）になるが
  Payment は AWAITING_PAYMENT のまま進まず、再発行（EXPIRED のときだけ受け付ける）もできない。invoice の無効化はアプリだけが行う前提とする。
- 同じく、BTCPay の管理画面で invoice を手で Settled・Invalid にする操作（Mark as settled / invalid）は行わない前提とする。
  手で Settled にすると、入金がなくても PAID になり、Shopify の注文も支払い済みになる。手で Invalid にした invoice は、
  アプリが入金を観測していれば INVALID_PAYMENT で人の対応に回るが、観測する前なら入金を見落とす。
- PAID の後に入金が reorg で無効になっても、MVP では何もしない（フラグも付かない）。方針（INVALID_PAYMENT を付ける）は ADR 9 にあり、実装は stretch。
- 孤児回復で作り直す前に注文を確かめ直し、キャンセル済み・支払い済みなどで invoice を作れなかった試行は、CREATING のまま残る。
  スイープは回るたびにその試行を確かめ直し、拡張は「作成中」として待ち続ける（終わりの状態は設けていない。ADR 4）。
- invoice を作った後に Shopify で注文がキャンセルされても、invoice は有効なまま残り、拡張も返し続ける。注文の自動キャンセルとあわせて stretch で扱う。
  その invoice に入金があっても、キャンセル済み・返金済みなどの注文は支払い済みにしない。注文には `btc-review-not-marked-paid` のタグを付ける（ADR 8）。
- BTCPay が受け付けない少額の注文（固定レートで換算すると dust の下限を下回る額。regtest の `BTC_JPY = 10,000,000` では数十円）は、
  invoice の作成が 400 で断られ、試行は CREATING のまま残る。拡張は「準備中」で待った後、問い合わせをやめて「再表示してください」と出す。
  最小額のチェックは設けていない（2026-10-08 の E2E で、¥10 のギフトカードの注文で確認）。
- 手動決済方法の名前「Bitcoinで支払う」をコードで持っている（空白と全角・半角の違いは無視して比べる）。管理画面で名前を変えると、どの注文にも invoice が作られなくなる。

## ADR 一覧

| # | タイトル | 書く週 |
|---|---|---|
| 1 | [Shopify チェックアウトへの組み込み方式](adr/0001-checkout-integration.md) | W2 |
| 2 | [オンチェーンを優先し、Lightning は stretch](adr/0002-onchain-first.md) | W1 |
| 3 | [1アプリ構成と、依存を内側に向けたレイヤー分割](adr/0003-single-app-ports-and-adapters.md) | W1 |
| 4 | [請求額はサーバー側で取得する／ゲスト購入のリスクの受け入れ](adr/0004-server-side-amount-and-guest-risk.md) | W2 |
| 5 | [invoice の二重作成防止と孤児の回復](adr/0005-invoice-creation-dedup-and-orphan-recovery.md) | W2 |
| 6 | [状態と review フラグを分ける](adr/0006-status-and-review-flags.md) | W1 |
| 7 | [有効な試行をポインタで保証する](adr/0007-current-attempt-pointer.md) | W1 |
| 8 | [inbox と冪等な外部呼び出し（outbox を見送る）](adr/0008-inbox-and-idempotent-side-effects.md) | W3 |
| 9 | [支払い済みとする条件と異常系のポリシー](adr/0009-payment-confirmation-and-anomaly-policy.md) | W3 |
| 10 | [固定レートとテストの決定性、テストの役割分担](adr/0010-deterministic-testing.md) | W1 |
