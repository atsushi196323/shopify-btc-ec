# ADR 3: 1アプリ構成と、依存を内側に向けたレイヤー分割

- ステータス: 承認（2026-10-02、W1 で雛形を作った結果を反映）
- 日付: 2026-10-01

## コンテキスト
Shopify CLI のテンプレート（React Router）は、OAuth・セッション・Webhook 受信などを提供する。
決済のドメインロジックを、このフレームワークとどう関係づけるかを決める必要がある。

## 決定
**テンプレート1つの中に、フレームワークに依存しない `domain / application / adapters` を置く。**

```
app/routes/         Webhook 受信・拡張 API・管理画面（薄く保つ）
src/domain/         状態機械・フラグ・不変条件（依存ゼロ）
src/application/    ユースケース（ポートとなるインターフェースを定義する）
src/adapters/       btcpay / shopify / db / shopify-fake
```

依存の向きは `routes → application → domain` に限る。adapters は application が定義したポートを実装する。

### W1 で雛形を作って確定したこと（2026-10-02）
- `shopify app init --template reactRouter --flavor typescript --package-manager npm` で `apps/shop-app/` に作った（Shopify CLI 4.8.3）。
  上の `app/routes/` と `src/` は、どちらも `apps/shop-app/` からの相対パス。`tsconfig.json` の `include` が `**/*.ts` なので、`src/` は追加の設定なしで型検査の対象になる。
- テンプレートはすでに Prisma（6.19.3）+ SQLite でセッションを保存している。決済のテーブルも同じ Prisma スキーマと DB に置き、`src/adapters/db/` から使う（DB を分けない）。
- 管理画面のルーティングは `flatRoutes()`（ファイル名ベース）。Webhook 受信と拡張 API も `app/routes/` のファイルとして置く。
- リポジトリは1つのまま。`shopify app init` が `apps/shop-app/` の中に作る空の `.git` は削除した。
- テンプレートのサンプル（商品作成のデモ、メタオブジェクト、`write_products` などのスコープ）は今は残し、必要なスコープが決まる W2 で整理する。

## 検討した代替案
- **決済ロジックを別のバックエンドサービス（Hono / Fastify）に分ける**: サービス間の認証、デプロイ、ローカル環境の手間が増えるわりに、評価は上がらない。依存の向きの制御は、ディレクトリ構成とテストで十分に示せる。

## 結果
- ドメインの単体テストは外部依存ゼロで書ける。
- 統合テストでは、コンポジションルートで Shopify アダプタをフェイクに差し替え、BTCPay アダプタをデコレータで包める（[ADR 10](0010-deterministic-testing.md)）。
- 将来サービスを分けたくなっても、`src/` をそのまま移せる。
