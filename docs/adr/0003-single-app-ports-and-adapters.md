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
- テストは `apps/shop-app/tests/{unit,adapter,integration}/` に置く（design.md のリポジトリ構成ではルートの `tests/`）。
  依存パッケージが `apps/shop-app/node_modules` にあり、ルートからは解決できないため。ルートを npm workspaces にする手間を避けた（W1 ② で判断）。
  テストランナーは vitest。`vite.config.ts` は React Router のプラグインを読み込むので、テスト用に `vitest.config.ts` を分けた。
- リポジトリは1つのまま。`shopify app init` が `apps/shop-app/` の中に作る空の `.git` は削除した。
- テンプレートのサンプル（商品作成のデモ、メタオブジェクト、`write_products` などのスコープ）は今は残し、必要なスコープが決まる W2 で整理する。

## 検討した代替案
- **決済ロジックを別のバックエンドサービス（Hono / Fastify）に分ける**: サービス間の認証、デプロイ、ローカル環境の手間が増えるわりに、評価は上がらない。依存の向きの制御は、ディレクトリ構成とテストで十分に示せる。

## 結果
- ドメインの単体テストは外部依存ゼロで書ける。
- 統合テストでは、コンポジションルートで Shopify アダプタをフェイクに差し替え、BTCPay アダプタをデコレータで包める（[ADR 10](0010-deterministic-testing.md)）。
- 将来サービスを分けたくなっても、`src/` をそのまま移せる。

## 追記（2026-10-04）: パッケージマネージャを pnpm に揃える
テンプレートには `package-lock.json`（npm）と `pnpm-workspace.yaml` の両方があり、実際の `node_modules` は pnpm で入っていた。
拡張を生成したときに CLI が pnpm で依存を入れ、`pnpm-lock.yaml` ができたので、ロックファイルが2種類になった。
- pnpm に揃え、`package-lock.json` を削除した。`package.json` に `packageManager: pnpm@11.0.9` を書き、CI（W4）は corepack で同じ版を使う。
- 拡張（`extensions/*`）は pnpm のワークスペースとして同じロックファイルで管理する。
- テンプレートの `Dockerfile` と `docker-start` も pnpm に直した。Docker でのデプロイは対象外なので、ビルドの確認はしていない。
