# ADR 10: 固定レートとテストの決定性、テストの役割分担

- ステータス: 承認（2026-10-02、W1 の compose 検証の結果を反映）
- 日付: 2026-10-01

## コンテキスト
採用担当は、ローカル環境を用意せずに成果物を評価する。そのため、CI で「実際に動く決済フローが継続的に検証されている」ことを示したい。
一方で、次のような不安定要素がある。
- BTCPay は regtest でも、既定では外部のレート取得元（インターネット）を使う。
- 同時実行のテストは、そのままだと競合が起きたり起きなかったりする。

## 決定

### 決定性
- 通貨は JPY。BTCPay の rate rules で **`BTC_JPY` を固定値**にする。
- ブロック生成は `bitcoin-cli generatetoaddress` で、テストから明示的に行う。
- invoice の期限は、テスト用に短く設定する（例: 1分）。
- 競合とクラッシュは、BTCPay アダプタを包む**テスト用デコレータ**で再現する。
  - 遅延の注入: 作成処理の直前に待つ（競合が起きる時間帯を広げる）
  - 例外の注入: 本物の作成処理に委譲した後、成功を返さずに例外を投げる（BTCPay にだけ invoice が残る状態を作る）
  - **本番コードには、テスト用の条件分岐を入れない。**

### テストの構成
- 統合テストは、**テストプロセスの中でアプリを組み立てる**（コンポジションルートを呼び、デコレータやフェイクを差し込む）。
- compose に入れるのは依存サービス（bitcoind・NBXplorer・BTCPay・Postgres）だけ。
  BTCPay の Webhook はホスト上のテストプロセスに送る。CI（Linux）では `extra_hosts: host.docker.internal:host-gateway` を使う。
- Shopify はフェイクのアダプタに差し替える。本物の API との食い違いは、GraphQL を Admin API のスキーマに対して検証することで防ぐ（下の「codegen の代わりにスキーマで検証する」）。

### 役割分担
| 検証したいこと | 担当 |
|---|---|
| ドメインの正しさ（全遷移と不変条件） | 単体テスト |
| BTCPay・bitcoind との結合、異常系、冪等性、競合 | 統合テスト（CI、シナリオ1〜9） |
| Shopify との結合、拡張の表示、アプリ全体の起動 | 手動の E2E（README に手順を書く）とデモ動画 |

### W1 の compose 検証で確定した値（2026-10-02）
手順は `infra/regtest/README.md` にある。`docker compose down -v` から同じ手順で再現できることを確認した。
- 固定レートは `BTC_JPY = 10000000`（1円 = 10 sat）。1000円の invoice が 0.0001 BTC になり、外部のレート取得元を使わないことを確認した。
- ストアの設定: Speed Policy は MediumSpeed（1 conf、ADR 9）、支払い許容誤差 0%、invoice の期限 60秒、期限後の監視 300秒。
  - **2026-10-08 に invoice の期限を 180秒に変えた**（bootstrap.sh と README）。手動の E2E で、Thank you ページの「Bitcoin で支払う」から
    BTCPay の支払い画面を開いて支払う確認が、60秒では間に合わなかったため。期限切れを待つ統合テスト（W3 のシナリオ2・3）は、1件あたり約3分かかる。
- 送金直後は Processing、1ブロック生成で Settled になる。
- bitcoind のイメージは初回起動時に `default` ウォレットを作って 101 ブロック生成するので、テストの支払いにはこのウォレットを使う。
- Webhook は `host.docker.internal:3000` に届き、`BTCPay-Sig` は生のボディの HMAC-SHA256（鍵は Webhook 登録時の secret）と一致した。

## 検討した代替案
- **CI でアプリもコンテナとして起動する**: テストプロセスからデコレータを差し込めない。
  環境変数でデコレータを切り替えると、本番の起動経路にテスト用の分岐が入る。
- **公開デモ環境（signet で BTCPay をクラウドに置く）**: regtest をローカルで動かす方針から外れ、運用コストもかかる。

## 結果
- CI のバッジで、統合テストが継続的に通っていることを示せる。
- 本番のレート取得元とレートの有効期限は対象外（既知の制限）。
- ローカル環境の制約: Docker の再起動による自動復帰では `depends_on` が効かない。postgres より先に NBXplorer が起動すると、
  NBXplorer は DB 接続に失敗したまま再試行しない。`docker compose up` から起動する CI には影響しないので、
  対策は README の復旧手順（`restart nbxplorer btcpayserver`）に留める。

## codegen の代わりにスキーマで検証する（2026-10-05、W2 の Shopify アダプタ）
テンプレートの codegen（`pnpm graphql-codegen`、`@shopify/api-codegen-preset`）は、スキーマの読み込みで
`Cannot use GraphQLNonNull "String!" from another module or realm` になり、型を生成できなかった。
ディスク上の `graphql` は 16.14.2 の1つだけで、設定ファイルを CommonJS にしても変わらなかった。
ESM と CommonJS で別々に読み込まれている可能性が高いが、原因は特定していない（30分で区切った）。
- **決定**: codegen は使わず、Admin API のスキーマを `apps/shop-app/graphql/admin-2026-07.graphql` に保存し（`pnpm schema:admin`、説明文を除いて約 770KB）、
  アダプタのクエリをテストで検証する（`tests/adapter/shopify/`）。
  - `graphql` の `validate` で、クエリがスキーマに対して妥当であること
  - 結果の型は手で書き、各項目の null 許容がスキーマと一致すること
- クエリにスキーマにない項目を入れた場合と、null 許容の違う項目に変えた場合に、テストが失敗することを確かめた。
- 型の生成はしないので、クエリを変えたら結果の型も手で直す。食い違えば上の2つめのテストが失敗する。
- codegen の修正は stretch（その他）に回す。

## 追記（2026-10-06）: Docker を使わない CI を W2 に前倒しする
- `.github/workflows/ci.yml` で、PR と main への push のたびに `pnpm typecheck` と `pnpm test`（単体・アダプタ）を流す。
  Docker を使わないので、入れる手間が小さい。invoice 作成やワーカーをドメインの上に積む前に、不変条件と、スキーマに対するクエリの検証が自動で流れるようにする。
- 統合テスト（BTCPay・bitcoind を compose で起動するもの）の CI は、予定どおり W4 で追加する。シナリオが揃っていないので、今作ると作り直しになる。
- 時間は W4 の GitHub Actions の作業から前借りした扱いにする（全体の時間は増やさない）。
- lint は CI に入れていない。拡張の生成ファイル（`extensions/thank-you/shopify.d.ts` の `@ts-ignore`）で失敗するため。直すときに CI へ加える。

## 追記（2026-10-09）: Docker Desktop 29 で host.docker.internal が IPv6 を返す
- Docker Desktop 29.8 では、コンテナの `/etc/hosts` に `host.docker.internal` の IPv6 アドレスも入る。BTCPay（.NET）はそちらを選び、
  コンテナに IPv6 の経路がないので、Webhook が `Network is unreachable` で届かなかった（IPv4 の 192.168.65.254 には届く）。
- compose の BTCPay に `DOTNET_SYSTEM_NET_DISABLEIPV6=1` を設定し、IPv4 だけを使わせる。CI（Linux）の `host-gateway` には影響しない。

## 追記（2026-10-09）: lint と統合テストを CI に加える（W4 から前倒し）
- `.github/workflows/ci.yml` に統合テストのジョブ（`integration`）を加えた。`docker compose up -d` → `bootstrap.sh` → `pnpm test:integration` の順で流す。
  BTCPay の Webhook は、Linux でも `extra_hosts` の `host-gateway` でテストプロセス（port 3000）に届いた（初回の実行で12件が通過、約1分20秒）。
- 上の「追記（2026-10-06）」では、シナリオが揃っていないので統合テストの CI は W4 に回すとしていた。実際には、ジョブはシナリオを足しても変わらない
  （`tests/integration/` に置けば流れる）ので、作り直しにならないと判断した。W4 の GitHub Actions の作業から時間を前借りした扱いにする。
- lint も CI に加えた。エラーはすべて拡張の中にあったので、設定で次のとおり扱う（`.eslintrc.cjs`）。
  - `extensions/*/shopify.d.ts` は Shopify CLI が生成するので、lint の対象から外す。
  - 拡張のソースでは `process` を既知の変数にする（`process.env.APP_URL` は CLI がビルド時に埋め込む。ADR 1）。props の型の検査（`react/prop-types`）は切る。
- あわせて、トークンの権限を `contents: read` に明示し、同じ PR に続けて push したときは古い実行を止める（`concurrency`）。
- マージの前に CI の成功を必須にする設定（ブランチ保護）は、非公開リポジトリの無料プランでは使えない。今は、マージの前に CI の結果を手で確かめる。

## 追記（2026-10-10）: CI のランナーの版を固定する
- `ubuntu-latest` は 2026-10-19 から Ubuntu 26 に切り替わる（GitHub の告知が実行結果に出た）。MVP の完成とデモの時期に OS ごと変わるのを避けるため、
  両方のジョブを `ubuntu-24.04` に固定する。固定できるのは OS の版までで、イメージの中の Docker・compose は週ごとの更新で変わる。
  そこまで固定する（compose の版を指定するなど）のは、更新で実際に落ちたときに考える。Ubuntu 26 への移行は stretch に回す（design.md 8章）。
- `concurrency` のグループを、PR は ref ごと、main への push はコミットごとにする。同じグループでは、待っている実行が新しい実行に置き換えられるので、
  `cancel-in-progress` を切るだけでは、続けてマージしたときに途中のコミットが検証されない。
