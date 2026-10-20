# ADR 9: 支払い済みとする条件と異常系のポリシー

- ステータス: 承認（2026-10-12、シナリオ2・3・4・9 の統合テストで確認。PAID の後の reorg は方針のみで、実装は stretch）
- 日付: 2026-10-01

## コンテキスト
オンチェーン決済では、入金を検知してから承認されるまでに時間がかかる。
また、過少払い・過払い・期限切れ・期限後の入金・二重支払いなど、異常のパターンが多い。
返金と換金は対象外なので、自動で処理しない事象は人の対応に回す必要がある。

## 決定

### 支払い済みとする条件
- BTCPay の invoice が **Settled** になったら PAID にし、`orderMarkAsPaid` を呼ぶ。
- 承認数（Speed Policy）は設定値にし、既定は **1 conf**。
- Processing（入金を検知、承認待ち）の間は、拡張に「入金確認中」と表示する。

### 異常系
| 事象 | 扱い |
|---|---|
| 入金なしで期限切れ | EXPIRED。拡張から再発行できる（レートを取り直す） |
| 一部入金のまま期限切れ（支払い許容誤差は 0%） | UNRESOLVED + UNDERPAID |
| 過払い | PAID + OVERPAID |
| 期限後の入金 | **自動では支払い済みにしない**（レートが変わっているため）。UNRESOLVED + LATE_PAYMENT |
| CONFIRMING の間に Invalid | UNRESOLVED + INVALID_PAYMENT |
| 古い試行に期限後の入金があり、新しい試行が未入金 | 新しい invoice を無効化し、UNRESOLVED + LATE_PAYMENT |
| 古い試行に期限後の入金があり、新しい試行が CONFIRMING | 無効化しない。DOUBLE_PAYMENT を付け、Settled になったら PAID |
| 古い試行に期限後の入金があり、新しい試行が PAID | DOUBLE_PAYMENT |
| PAID の後に Invalid（reorg） | PAID のまま INVALID_PAYMENT を付ける（方針のみ。MVP の実装では何もしない。実装とテストは stretch） |

### 自分で無効化した invoice
- 無効化は commit の後に行う外部呼び出し。失敗したら、スイープが
  「UNRESOLVED なのに現在の試行が NEW」を見つけて無効化をリトライする（冪等）。
- 無効化の直前に入金された場合に備え、`invalidatedByUs` の試行を、無効化から一定期間（設定値）スイープの照合対象に含める。
  入金があれば DOUBLE_PAYMENT を付ける。
- 期間は regtest では短くする。本番では、未承認の取引がネットワークに伝わる時間を考えて長めに取る。

### 自動化しないことにした理由
- 返金・換金は対象外なので、お金の過不足を自動で解消する手段がない。
- 期限後の入金を自動で受け入れると、レートの変動分を店側が負担することになる。この判断は人がすべき。
- 自動化しない範囲を明示し、フラグで漏れなく人の対応に回すほうが、誤った自動処理よりも安全。

## 未検証事項（W3）
- 無効化した invoice に入金したときの BTCPay の挙動（どの Webhook が送られるか、Greenfield での見え方）を regtest で確認する。
  想定と違えば、検知方法（ウォレットのアドレス監視に切り替えるかなど）をその時点で決め、ここに記録する。

## 未検証事項の確認結果（2026-10-09、regtest の BTCPay 2.4.4）
Greenfield の `POST /invoices/{id}/status`（`Invalid`）で無効化した invoice について、次の3つを試した。

| 試したこと | 無効化の応答 | invoice の `status` / `additionalStatus` | `payment-methods` | 届いた Webhook |
|---|---|---|---|---|
| A: 未入金で無効化し、その後に全額を入金・1ブロック | 200 | `Invalid` / `Marked` のまま変わらない | `totalPaid` = 全額、`payments` が Processing → Settled | `InvoiceReceivedPayment`・`InvoicePaymentSettled`（`afterExpiration: true`） |
| B: 一部入金（NEW・PaidPartial）の後に無効化 | 200 | `Invalid` / `Marked` | `totalPaid` = 一部の額 | `InvoiceInvalid`（`manuallyMarked: true`）、後で `InvoicePaymentSettled` |
| C: 全額入金（Processing）の後に無効化 | 200 | `Invalid` / `Marked` | `totalPaid` = 全額 | `InvoiceInvalid`（`manuallyMarked: true`）、後で `InvoicePaymentSettled` |

- **想定と違った点**: 無効化した invoice への入金は、invoice の `status` / `additionalStatus` に現れない（`Invalid` / `Marked` のまま）。
  入金は `payment-methods` の `totalPaid` と `payments` にだけ記録される。今のアダプタは `Marked` を「入金なし」（NONE）に変換するので、
  Webhook が届いてワーカーが取り直しても、この入金を見落とす（DOUBLE_PAYMENT が付かない）。
- **BTCPay は入金のある invoice の無効化も受け付ける**（B・C）。「無効化の直前に入金された」場合も、無効化は成功し、invoice の状態からは入金が読めなくなる。
- Webhook は届くので、入金の契機の検知はウォレットのアドレス監視に切り替えなくてよい。スイープの照合（無効化から一定期間）は、Webhook を取りこぼした場合の予備として予定どおり残す。

### 決定（検知方法）
- **`Invalid` の invoice は、アダプタで `payment-methods` の `totalPaid` も取得し、入金の様子（`received`）をそこから決める**。
  `totalPaid` が 0 なら NONE、全額に届いていれば FULL（超えていれば OVER）、届いていなければ PARTIAL とする。
  ドメインは変えない。INVALID の試行に入金があれば、`invalidatedByUs` の試行では DOUBLE_PAYMENT（相手に入金がある場合）、
  そうでない試行では INVALID_PAYMENT になる（ADR 6 の判定のまま）。
- 実装は W3 の無効化の PR で行い、シナリオ2（古い invoice への期限後の入金で、新しい invoice を無効化する）で、無効化後の入金も確かめる。
- 未確認のまま残すこと: 監視期間（ストアの `monitoringExpiration` = 300秒）を過ぎた後に、無効化した invoice へ入金があった場合の扱い。
  今回の入金は無効化の数秒後だった。本番で監視期間をどう取るかと合わせて、既知の制限に書く。

## 結果
- テスト: シナリオ1〜4。シナリオ2 では、古い invoice への期限後の入金で新しい invoice が無効化されることも確認する。
- 注文の自動キャンセルは stretch。

## W3 で決めたこと（2026-10-10、無効化と再発行）
- **無効化は、意図を先に DB に記録してから BTCPay を呼ぶ**（`src/application/invalidate-attempt.ts`）。
  `invalidatedByUs`・`invalidatedAt` を version 付きで保存し（判定に効くので version を上げる）、commit の後に Greenfield の `POST /invoices/{id}/status`（`Invalid`）を呼ぶ。
  BTCPay を先に呼ぶと、無効化の直後に届いた入金を、まだ `invalidatedByUs` でない試行への入金（INVALID_PAYMENT）と判定しうる。
  BTCPay の呼び出しが失敗しても `invalidatedByUs` は残り、試行は NEW のままなので、スイープ（W4）が「UNRESOLVED なのに現在の試行が NEW」として呼び直す。
- 無効化する試行かどうかは、ドメインの `attemptToInvalidate` で判定する。ワーカーは保存の commit の直後に、無効化 → Shopify への反映の順に呼ぶ。
  invoice の紐づけ（初回の作成・再発行・孤児の回復）の後にも、紐づけのドメインの判定が無効化を求めたときだけ呼ぶ。再発行の作成中（新しい試行が CREATING）に古い試行へ期限後の入金があると、
  Payment は先に UNRESOLVED になり、紐づけた時点で初めて「UNRESOLVED なのに現在の試行が NEW」になるため。
- すでに Invalid の invoice の無効化は 422 になる（regtest の BTCPay 2.4.4 で確認）。アダプタは 422 のとき invoice を取り直し、Invalid なら成功とみなす（冪等）。
- **検知方法の実装**: アダプタは無効化した invoice（`Invalid` / `Marked`）を取得するときに `payment-methods` も取得し、オンチェーン（`BTC-CHAIN`）の `totalPaid` と `amount` から `received` を決める。
  BTCPay が二重支払いなどで Invalid にした invoice（`additionalStatus` が `Marked` 以外）は、これまでどおり `additionalStatus` で判定する。
  金額の比較は10進数の文字列のまま行う（浮動小数点に変換しない）。
- **再発行**（`reissueInvoice`、design.md 5.4）: Payment が EXPIRED のときだけ受け付ける。
  - Payment のショップがセッションのショップと違えば、Payment がないものとして断る（拡張から届いた注文 ID は信用しない。ADR 4）。
    EXPIRED のときだけ Admin API で注文を確かめ、請求額を取り直す。invoice を作れない注文（キャンセル済みなど）では、新しい試行を作らない。
  - 保存するのはドメインの `reissue()` の結果（新しい試行・ポインタ・status）。リポジトリで遷移を組み立て直さない。
  - 新しい試行の作成・ポインタの付け替え・Payment の CREATING を、version 付きの1つのトランザクションで行う。並列に押されても、勝つのは1つだけ。
  - commit の後に BTCPay に invoice を作って紐づける（初回の作成と同じ処理）。途中で落ちて CREATING のまま残った試行は、スイープの孤児回復が追いつかせる。
  - 拡張: `POST /api/extension/reissue`。期限切れの表示に「お支払いリンクを再発行する」ボタンを出し、応答の表示状態で問い合わせを始め直す。
- テスト:
  - 単体・アダプタ: `tests/adapter/btcpay/invoice-observation.test.ts`（`totalPaid` からの判定と10進数の比較）、
    `tests/application/reissue-and-invalidate.test.ts`（並列の再発行で試行は1件、無効化の失敗と呼び直し、新しい試行が入金済みなら無効化しない）
  - 統合（regtest）: `tests/integration/btcpay/greenfield-client.test.ts`（無効化の冪等性、無効化した invoice への入金が INVALID・FULL）、
    `tests/integration/scenario-02-03-04-09-anomalies.test.ts` でシナリオ2・3・4・9 を確かめた。
    シナリオ2では、古い invoice への期限後の入金で新しい invoice が BTCPay で Invalid になり、その後の新しい invoice への入金で DOUBLE_PAYMENT が付くことも確かめた。
    期限切れを待つシナリオは、テスト用のデコレータ（`tests/helpers/short-expiry-btcpay.ts`）で期限1分の invoice を作り、並行に流す（BTCPay は1分未満の期限を受け付けない）。

## W4 で決めたこと（2026-10-12、スイープの無効化と監視）
- 監視期間は **600 秒**（`DEFAULT_SWEEP_SETTINGS.invalidatedWatchMs`）。無効化の時刻から数える。BTCPay が入金を拾うのは invoice の作成から
  期限（ストアの `invoiceExpiration` 180 秒）+ `monitoringExpiration`（300 秒）までで、無効化は作成より後なので、600 秒あれば BTCPay が入金を拾える間は必ず照合する。
  ストアの期限や監視の設定を延ばしたら、この値も延ばす（2026-10-12 のレビューで、この結びつきを明記した）。
- 無効化のリトライ（design.md 5.5 の 3）は、「Payment が UNRESOLVED で、ポインタが指す試行が NEW」をクエリで探し、`invalidateAttempt` を呼び直す。
  無効化した試行は同じ回の監視（5.5 の 4）で照合されるので、BTCPay で Invalid になったことはその回のうちに試行に写る（INVALID になれば、次の回からは無効化の対象から外れる）。
- テスト: `tests/application/sweep.test.ts`（無効化の失敗からのリトライ、監視期間の間の入金で DOUBLE_PAYMENT、監視期間を過ぎたら照合しない）。
