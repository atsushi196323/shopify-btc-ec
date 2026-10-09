# ADR 9: 支払い済みとする条件と異常系のポリシー

- ステータス: 提案（下書き。W3 の実装時に確定）
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
