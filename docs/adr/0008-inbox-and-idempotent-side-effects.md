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

## W3 で決めたこと（2026-10-10、Shopify への反映）
- **Payment に `shop` 列を足した**（設計に足りなかった点）。BTCPay の Webhook とスイープは Shopify からのリクエストではないので、
  どのショップのオフラインセッション（`unauthenticated.admin(shop)`）で Admin API を呼ぶかを、Payment から決める必要がある。
  - 予約（`reserve`）のときに、`orders/create` はテンプレートが検証したショップを、拡張 API はセッショントークンの `dest` を入れる。
  - `shopifyOrderId` の UNIQUE はそのまま。注文の GID はショップをまたいで一意。
  - 列を足す前の開発用の行は、開発ストア（1店舗）のオフラインセッションのショップで埋めた（マイグレーションの SQL）。
- 反映は `src/application/sync-to-shopify.ts`。ワーカーの1件分（`handleBtcpayEvent`）が、保存の commit の直後に、
  `needsShopifySync` のときだけ1回呼ぶ。スイープ（W4）も同じ関数を呼ぶ。
  - 未対応のフラグから導出したタグを `tagsAdd` で付ける。書式は理由を小文字とハイフンにしたもの（例: `btc-review-late-payment`）。
    支払い済みにできない注文（キャンセル済みなど）でも異常が Shopify で見えるように、タグを `orderMarkAsPaid` より先に付ける。
  - PAID なら、`getOrder` で `displayFinancialStatus` を確かめ、PAID でなければ `orderMarkAsPaid` を呼ぶ。
    呼ぶのは、支払いを待っている注文（`PENDING`・`PARTIALLY_PAID` で、キャンセルされていない。invoice を作れる注文と同じ。ADR 4）だけにする（2026-10-10 のレビューで追加）。
    キャンセル済み・返金済みなど、支払い済みにできない注文で呼ぶと失敗し続け、反映が PENDING のまま残ってほかの失敗を埋もれさせるため。
    そうした注文には、入金は確定したのに支払い済みにできなかったことを示すタグ `btc-review-not-marked-paid` を付けて DONE にする
    （フラグにない事情だが、返金などを人が判断する必要がある）。
  - mutation の `userErrors` と、payload が null の結果も失敗として扱う。失敗は `shopifySyncError` に記録し、PENDING のまま残す。すでに DONE なら記録しない。
  - 同じ Payment の反映は、プロセスの中で順番に流す（Payment ごとの待ち行列）。並行した2つの反映が、どちらも未払いと見て
    `orderMarkAsPaid` を2回呼ぶのを防ぐ。ワーカーとスイープは同じプロセスで動くので、これで足りる（水平スケールは考慮しない）。
- DONE にできなかった（version が変わっていた）ときは、読み直して反映し直す（最大3回）。version は試行だけの変更（一部入金の記録など）でも上がるので、
  読み直さないと、反映することが残っていないのにスイープまで PENDING のまま残る。3回続いたら PENDING のまま残し、スイープに任せる。
- invoice の紐づけ（CREATING → AWAITING_PAYMENT）でも PENDING になるが、作成の経路では反映を呼ばない。Shopify に反映することがないので、
  スイープが DONE にするまで PENDING のまま残っても害はない。
- テスト:
  - アダプタ: `tests/adapter/shopify/admin-gateway.test.ts`（`orderMarkAsPaid`・`tagsAdd` を保存したスキーマで検証し、結果の型の null 許容をスキーマと照合する）、
    `tests/adapter/db/prisma-payment-repository.test.ts`（version が変わっていたら DONE にしない）
  - application: `tests/application/sync-to-shopify.test.ts`（支払い済みの注文には呼ばない、失敗の記録と追いつき、反映中の変更で反映し直す）
  - 統合: `tests/integration/btcpay-webhook-worker.test.ts` でシナリオ1（PAID → Shopify の注文が支払い済み）とシナリオ5を確かめた。
    シナリオ5は、BTCPay の Redeliver で `InvoiceSettled` を再送する。再送は新しい `deliveryId` で届くので inbox では落ちないが、
    状態の判定で NO_CHANGE になり、反映は呼ばれない（`orderMarkAsPaid` は1回のまま）。

## W4 で決めたこと（2026-10-12、スイープ）
- スイープは `src/application/sweep.ts` の `runSweep`。design.md 5.5 の6段（孤児の回復 → 照合 → 無効化のリトライ → 無効化した試行の監視 → inbox の再処理 → Shopify への反映）を、この順に1回ずつ流す。
  順番に意味がある。前の段で保存した変更（照合で PAID・UNRESOLVED になったなど）を、同じ回の後の段（無効化・反映）が拾う。
- 各段は、対象をリポジトリのクエリで探し、既存の冪等な処理（`recoverCreatingAttempt`・`invalidateAttempt`・`handleBtcpayEvent`・`syncPaymentToShopify`）を1件ずつ呼ぶだけにした。
  1件の失敗（例外）は結果に ERROR として残し、残りの件は続ける。次の回で呼び直す。
- 照合（2・4）は、ワーカーの判定と保存（`apply`）を inbox なしで呼ぶ `reconcileInvoice` にした。そのために `saveObservation` の `inboxId` を NULL にできるようにした。
  照合のたびに inbox の行を作ると、変わるものがない行が回ごとに増えるため。照合では、無効化と反映をその場では呼ばず、後の段に任せる。
- 起動は `app/sweep.server.ts`。サーバーのエントリ（`app/entry.server.tsx`）が読み込まれたときに、プロセスの中で 30 秒ごとに回す。
  前の回が終わってから次の回を予約するので、回は重ならない。開発サーバーがモジュールを読み直しても二重に起動しないよう、プロセスで1つのフラグを持つ。
  依存は回ごとに組み立て、BTCPay の設定を毎回読む（`invoiceDeps` と同じ）。ログは NO_CHANGE 以外の結果があった段だけに出す。
  本番（`react-router-serve`）はビルドを起動時に読み込むので起動と同時に始まるが、開発サーバー（Vite）では最初のリクエストまで始まらない（開発時だけの制約として受け入れる）。
- inbox の再処理は、受信か最後の失敗から 30 秒（`inboxRetryAfterMs`）経った行だけにした（2026-10-12 のレビューで追加）。受信の直後にワーカーが処理している行と重なると、
  紐づけ前のイベントの失敗を両方が記録し、10回の上限に約2倍の速さで達するため。
- レビューで挙がったが、MVP では手を入れないこと: 照合は NEW・PROCESSING の invoice を回ごとに1件ずつ取り直す（件数に比例して回が長くなる）。
  スイープのクエリには件数の上限がなく、`invalidatedByUs`・`invalidatedAt` に索引もない。ポートフォリオの規模（数十件）では問題にならない。
- テスト:
  - application: `tests/application/sweep.test.ts`（6段それぞれ、閾値より新しい孤児には触れない、1件の失敗で止まらない、監視期間を過ぎたら照合しない）
  - 統合（regtest）: `tests/integration/scenario-06-sweep-without-webhooks.test.ts` でシナリオ6を確かめた。テストの Webhook の受け口が配信を捨て（200 を返す。
    失敗を返すと BTCPay が後続の配信を止めるため）、入金と1ブロックの後に BTCPay で Settled になっても、アプリは支払い待ちのまま。
    スイープを1回回すと照合で PAID になり、同じ回の反映で Shopify の注文が支払い済みになる。もう一度回しても Shopify の呼び出しは増えない。
