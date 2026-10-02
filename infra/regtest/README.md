# regtest 環境の手動セットアップ手順

`docker compose down -v` で全部消した状態から、JPY 建ての invoice を支払って Webhook を受け取るまでの手順。
W1 の compose 検証（design.md 8章の完了ライン 1〜5）で使った。スクリプト化は W1 ④ / W2 で行う。

認証情報とレートはローカルの regtest 専用の値。

| 項目 | 値 |
|---|---|
| BTCPay 管理者 | `admin@example.com` / `Passw0rd!regtest` |
| 固定レート | `BTC_JPY = 10000000`（1円 = 10 sat） |
| ストア | JPY、Speed Policy は MediumSpeed（1 conf）、支払い許容誤差 0%、期限 60秒（ADR 9・10） |

以下はリポジトリのルートで実行する。

## 0. 準備

```sh
B=http://localhost:49392
cli() { docker compose -f infra/regtest/docker-compose.yml exec -T bitcoind \
  bitcoin-cli -regtest -rpcuser=ceiwHEbqWI83 -rpcpassword=DwubwWsoo3 -rpcport=43782 "$@"; }
```

## 1. 起動と同期の確認

```sh
docker compose -f infra/regtest/docker-compose.yml up -d
curl -s $B/api/v1/health   # {"synchronized":true} になるまで待つ
```

bitcoind のイメージは初回起動時に `default` ウォレットを作り、101 ブロック生成する（50 BTC 使える）。

## 2. 管理者・API キー・ストア・ウォレット

```sh
curl -s -X POST $B/api/v1/users -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"Passw0rd!regtest","isAdministrator":true}'

K=$(curl -s -u 'admin@example.com:Passw0rd!regtest' -X POST $B/api/v1/api-keys -H 'Content-Type: application/json' \
  -d '{"label":"regtest-dev","permissions":["unrestricted"]}' | jq -r .apiKey)
H="Authorization: token $K"

SID=$(curl -s -X POST $B/api/v1/stores -H "$H" -H 'Content-Type: application/json' \
  -d '{"name":"regtest-store","defaultCurrency":"JPY","speedPolicy":"MediumSpeed","paymentTolerance":0,"invoiceExpiration":60,"monitoringExpiration":300}' \
  | jq -r .id)

curl -s -X PUT $B/api/v1/stores/$SID/rates/configuration/primary -H "$H" -H 'Content-Type: application/json' \
  -d '{"isCustomScript":true,"effectiveScript":"BTC_JPY = 10000000;"}'

# v2 系のパス（v1 系の .../payment-methods/onchain/BTC/generate ではない）
curl -s -X POST $B/api/v1/stores/$SID/payment-methods/BTC-CHAIN/wallet/generate -H "$H" -H 'Content-Type: application/json' \
  -d '{"savePrivateKeys":true,"scriptPubKeyType":"Segwit","importKeysToRPC":true}'
```

## 3. Webhook の受信先

別のターミナルで仮エンドポイントを起動し、BTCPay に登録する。

```sh
node infra/regtest/webhook-echo.mjs
```

```sh
curl -s -X POST $B/api/v1/stores/$SID/webhooks -H "$H" -H 'Content-Type: application/json' \
  -d '{"url":"http://host.docker.internal:3000/webhooks/btcpay","enabled":true,"automaticRedelivery":true,"authorizedEvents":{"everything":true}}'
```

返ってくる `secret` が、`BTCPay-Sig`（ボディの HMAC-SHA256）の検証に使う鍵になる。

## 4. invoice の作成・支払い・ブロック生成

期限が 60秒なので、作成から送金までを続けて実行する。

```sh
IID=$(curl -s -X POST $B/api/v1/stores/$SID/invoices -H "$H" -H 'Content-Type: application/json' \
  -d '{"amount":"1000","currency":"JPY","metadata":{"orderId":"test-1"}}' | jq -r .id)
read ADDR AMT < <(curl -s $B/api/v1/stores/$SID/invoices/$IID/payment-methods -H "$H" | jq -r '.[0] | "\(.destination) \(.due)"')
cli -rpcwallet=default sendtoaddress $ADDR $AMT   # 1000円 → 0.0001 BTC。invoice は Processing になる
cli -rpcwallet=default -generate 1                # Settled になる
curl -s $B/api/v1/stores/$SID/invoices/$IID -H "$H" | jq -r .status
```

仮エンドポイントには `InvoiceCreated` → `InvoiceReceivedPayment` → `InvoiceProcessing` → `InvoicePaymentSettled` → `InvoiceSettled` の5件が届く。

## Docker を再起動したとき

postgres より先に NBXplorer が起動すると、NBXplorer は DB 接続に失敗したまま再試行しない。
`/api/v1/health` が `{"synchronized":true}` にならなければ、次で戻る。

```sh
docker compose -f infra/regtest/docker-compose.yml restart nbxplorer btcpayserver
```
