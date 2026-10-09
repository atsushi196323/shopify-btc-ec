# ADR 8: inbox と冪等な外部呼び出し（outbox を見送る）

- ステータス: 提案（下書き。W3 の実装時に確定）
- 日付: 2026-10-01

## コンテキスト
DB と外部システム（BTCPay、Shopify）を1つのトランザクションで更新することはできない。
- 受信側: Webhook の処理中に落ちると、送信元がリトライしてくれるとは限らない。
- 送信側: DB を PAID に更新した後、Shopify への通知の前に落ちると、不整合が残る。

さらに、イベント ID のユニーク制約だけでは足りない。
- Shopify の `X-Shopify-Event-Id` はリトライしても同じだが、BTCPay の `deliveryId` は手動で再送すると新しい ID になる。
- ユニーク制約に INSERT した後に処理が落ちると、リトライが重複として捨てられる。

## 決定
1. **Inbox**: 署名を検証したら、イベントを inbox に保存してすぐに 200 を返す。イベント ID の重複は、ここで早めに落とす（最適化）。
2. **状態の取り直し**: ワーカーはペイロードを信用せず、Greenfield API から invoice の最新状態を取り直す。
   この取得は**トランザクションの外**で行う。試行の状態は前にしか進まないので（[ADR 6](0006-status-and-review-flags.md)）、
   取り直した状態が古くても、無効な遷移として何もしないだけで害はない。反映されなかった分はスイープが拾う。
3. **楽観ロックで更新**: `version` 付きで更新し、競合したら DB を読み直して再判定する（Greenfield の再取得はしない）。
   リトライには上限を設け、超えたら inbox の行を PENDING のまま残し、次回のワーカーかスイープに任せる。
   再処理の合計回数が上限を超えたら FAILED にし、人が気づけるようにする。
4. **反映待ちを状態として持つ（`shopifySync`）**: status かフラグを変えるトランザクションの中で `Payment.shopifySync = PENDING` にし、
   inbox の行はその commit で DONE にする。
   - commit の後、反映処理を呼ぶ。`orderMarkAsPaid`（呼ぶ前に `displayFinancialStatus` を確認し、すでに PAID ならスキップ）と、未対応のフラグから導出したタグの付与を冪等に行う。
   - 終わったら `WHERE version = <読んだときの version>` 付きで DONE にする。反映中に別の変更が入っていれば PENDING のまま残る。
   - 失敗したら PENDING のまま `shopifySyncError` を記録し、スイープが追いつかせる。

   **反映を「遷移が起きた瞬間」だけに結びつけない**ことが要点。遷移の瞬間だけを起点にすると、反映に失敗した後の再処理では
   遷移が no-op になり、二度と反映されない。

**正しさは「状態機械」と「状態の取り直し」と「反映待ちの記録＋冪等な外部呼び出し」で担保する。** ユニーク制約は最適化にすぎない。

## outbox を見送る理由
- MVP で外部に起こす副作用は「Shopify に状態を反映する」の1種類だけ。
  `shopifySync = PENDING` が、状態の更新と同じトランザクションで書かれる「反映待ちの印」になる。
  これは副作用が1種類に限られた outbox の簡易版で、呼び出しも冪等なので、汎用の outbox テーブルがなくても正しく動く。
- 作業時間の制約がある。

## outbox へ移行する条件
- 1つのイベントから複数の種類の副作用（メール送信、注文の自動キャンセル、外部への通知など）を起こすようになったとき
- 副作用の実行を、イベントの受信から切り離して制御する必要が出たとき（流量制御や順序保証など）

## 結果
- 分散トランザクションを使わずに、at-least-once の配送と冪等な処理で結果整合を取る。
- ワーカーは同じアプリ内の簡易版。水平スケールは考慮しない（既知の制限）。
- テスト: シナリオ5（同じ Webhook を再送しても Shopify の呼び出しは1回）、シナリオ6（Webhook を遮断してもスイープで収束）。

## W2 で決めたこと（2026-10-06、送信先の置き換え）
- BTCPay の Webhook の送信先を、W1 の仮エンドポイントからアプリ本体の `app/routes/webhooks.btcpay.tsx` に置き換えた。
- W2 のこのルートは、受け取って 200 を返し、種類と invoice ID をログに出すだけ。署名の検証・inbox・ワーカーは W3 で実装する。
  署名を検証していないので、ペイロードの値はどの処理にも使わない。
- この間に捨てたイベントで状態を取りこぼしても、ワーカーとスイープは Greenfield から状態を取り直すので（決定の2）、W3 の照合が追いつかせる。

## W3 で決めたこと（2026-10-09、Webhook の受信とワーカー）
- 受信は `src/adapters/btcpay/webhook-handler.ts`（ルートと統合テストの両方から使う）。生のボディで `BTCPay-Sig` を検証し（不一致は 401）、
  invoice に関係するイベントだけを inbox に保存して 200 を返す。ワーカーは同じプロセスで起動し、応答はその終わりを待たない。
- inbox の重複の除去には `deliveryId` を使う。payload には、署名を検証したイベントのうち種類と invoice ID だけを保存する。
- ワーカーは `src/application/process-btcpay-event.ts`。決定の2・3のとおり、Greenfield から取り直し（トランザクションの外）、
  version 付きで保存し、競合したら DB だけを読み直して再判定する（最大3回）。上限に達するか例外が出たら PENDING のまま回数とエラーを記録し、
  合計10回で FAILED にする。保存と同じ commit で inbox の行を DONE にする。
  失敗の記録は try の外で1回だけ行う（記録そのものが失敗したら例外を返し、回数を二重に数えない）。記録の時点で別の処理が DONE にしていたら、処理済みとして扱う。
- 次のイベントは、何もせずに DONE にする（IGNORED）。
  - `orderId` 欄がない invoice（BTCPay の管理画面で手で作ったものなど）。アダプタが `ForeignInvoiceError` で知らせる
  - `orderId` 欄が、このアプリの試行に当たらない invoice
  - 試行に紐づかなかった方の invoice（ADR 5 の「同じ試行に invoice が2つできる場合」）
- invoice の作成の直後に届き、試行に invoice がまだ紐づいていないイベントは、PENDING のまま残す（紐づけの後に再処理する）。
- 無効化（`attemptToInvalidate`）と Shopify への反映は、ワーカーの結果として呼び出し側に返す。呼ぶ処理は次の PR で実装する。
- **BTCPay の自動再送は切る**（`infra/regtest/bootstrap.sh`）。BTCPay 2.4.4 は、配信に失敗すると再送の待ち（10秒・1分・10分…）が明けるまで、
  同じ Webhook の後続の配信を止める。アプリを止めていた後は、新しい invoice のイベントが10分以上届かなくなった（regtest で確認）。
  取りこぼしたイベントは決定の2のとおり、スイープが Greenfield から取り直すので、自動再送がなくても状態は収束する。スイープ（W4）ができるまでは、
  アプリが止まっていた間のイベントは反映されない。
- テスト:
  - 単体・アダプタ: `tests/adapter/btcpay/webhook.test.ts`（本物の BTCPay の配信の本体と、openssl で計算した署名のベクタ）、
    `tests/adapter/db/prisma-inbox-repository.test.ts`、`tests/application/process-btcpay-event.test.ts`（二重払いを並列に処理して DOUBLE_PAYMENT がちょうど1件。
    version の確認を外すと失敗することを確かめた）
  - 統合: `tests/integration/btcpay-webhook-worker.test.ts`。テストプロセスが port 3000 で Webhook を受け、本物の secret で署名を検証し、入金と1ブロックで PAID まで進む。
