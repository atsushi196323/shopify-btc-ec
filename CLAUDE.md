# shopify-btc-ec

Shopify の開発ストアに、BTCPay Server（regtest）を使った Bitcoin 決済を自作で組み込むポートフォリオ。

## 正とする資料
- 設計は `docs/design.md`、判断の理由は `docs/adr/`（ADR 1〜10）にある。実装前に該当する章と ADR を読む。
- 実装が設計と食い違う、または設計に足りない点を見つけたときは、勝手に直さず、まず報告する。

## 設計の凍結（2026-10-01）
- 設計のやり直しや、新しい仕組みの追加は提案しない。
- 新しく見つかった論点は、次のどれに回すかを添えて提案する（design.md 1章）。
  1. 実装中に判断し、その週の ADR に短く記録する
  2. README の「既知の制限」（design.md 9章）に書く
  3. stretch に回す（design.md 8章の優先順）
- ADR は最後にまとめず、実装したその週に書く（1件あたり約15分）。

## 計画と時間の上限
- 週ごとの作業、完了条件、時間の上限、届かなかったときの代わりの方法は design.md 8章にある。
- 上限を超えそうになったら作業を広げずに手を止め、次の手を選択肢で示す。
- 作業の範囲外のこと（後の週の作業など）は、気づいても実装せず、メモとして報告する。

## アーキテクチャ（ADR 3）
- Shopify CLI テンプレート（React Router）の単一アプリ `apps/shop-app/`。
- `src/domain/`: 状態機械・フラグ・不変条件。外部依存ゼロ（Prisma・Shopify・BTCPay の型も import しない）。
- `src/application/`: ユースケース。domain とポート（インターフェース）だけに依存する。
- `src/adapters/{btcpay,shopify,db}/`: 外部とのやり取り。CI 用に `src/adapters/shopify-fake/` を置く。
- `app/routes/`: Webhook 受信・拡張 API・管理画面。薄く保ち、処理は application に渡す。
- DB は SQLite + Prisma。WAL・`busy_timeout`・`foreign_keys = ON` で使い、外部キーが効いていることをテストで確かめる（design.md 3章、ADR 7）。

## テスト（ADR 10、design.md 7章）
- 単体: ドメインの全遷移と不正な遷移、フラグ、不変条件。依存なし。
- アダプタ: BTCPay の署名検証（既知のベクタ）、Shopify の GraphQL は codegen で型検査。
- 統合: 本物の BTCPay と bitcoind（regtest）、フェイクの Shopify。アプリはテストプロセスの中で組み立てる。
- 遅延や例外の注入は、BTCPay アダプタを包むテスト用デコレータで行う。本番コードにテスト用の分岐を入れない。
- レートは BTCPay の rate rules で `BTC_JPY` を固定値にする。

## ローカル環境
- regtest 環境: `infra/regtest/docker-compose.yml`（bitcoind・NBXplorer・BTCPay・Postgres）
  - 起動: `docker compose -f infra/regtest/docker-compose.yml up -d`
  - BTCPay 管理画面: http://localhost:49392
  - 状態確認: `curl -s http://localhost:49392/api/v1/health` が `{"synchronized":true}` になること
  - Docker 再起動後に NBXplorer・BTCPay が DB 接続エラーで止まっていたら:
    `docker compose -f infra/regtest/docker-compose.yml restart nbxplorer btcpayserver`
- アプリは port 3000 に固定する（`shopify.web.toml` の `port = 3000`）。
  - Shopify → アプリ: Shopify CLI のトンネル経由。`--use-localhost` は使わない（Shopify の Webhook が届かなくなる）
  - BTCPay → アプリ: `http://host.docker.internal:3000/webhooks/btcpay`

## Git
- コミットとプッシュは指示があったときだけ行う。作業単位でブランチを切り、PR で main に入れる。
- コミットメッセージは `種別: 日本語の要約` の形式（例: `docs: W1 の詳細計画を追記`）。
- 文書・コメント・コミットメッセージは日本語で書く。
