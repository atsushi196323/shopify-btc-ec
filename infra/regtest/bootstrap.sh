#!/usr/bin/env bash
# regtest の BTCPay を、JPY 建ての invoice を作って Webhook を送れる状態にする（README の手順 1〜3）。
# 何度実行しても同じ状態になる。作った値は infra/regtest/.bootstrap.env に書き出す（git には入れない）。
#
# 使い方: infra/regtest/bootstrap.sh
# 前提: docker compose -f infra/regtest/docker-compose.yml up -d 済み。curl と jq があること。
set -euo pipefail

cd "$(dirname "$0")"

BTCPAY_URL="${BTCPAY_URL:-http://localhost:49392}"
ADMIN_EMAIL="admin@example.com"
ADMIN_PASSWORD='Passw0rd!regtest'
STORE_NAME="regtest-store"
RATE_SCRIPT="BTC_JPY = 10000000;"
WEBHOOK_URL="http://host.docker.internal:3000/webhooks/btcpay"
ENV_FILE=".bootstrap.env"

log() { echo "[bootstrap] $*" >&2; }

# curl の結果を返し、HTTP エラーなら本文を出して止める
api() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -X "$method" "$BTCPAY_URL$path" -H "Authorization: token $API_KEY" -w '\n%{http_code}')
  [[ -n $body ]] && args+=(-H 'Content-Type: application/json' -d "$body")
  local res code
  res=$(curl "${args[@]}")
  code=${res##*$'\n'}
  res=${res%$'\n'*}
  if [[ $code -ge 400 ]]; then
    log "$method $path -> HTTP $code: $res"
    exit 1
  fi
  printf '%s' "$res"
}

# 1. 起動と同期の確認
log "BTCPay の同期を待っています ($BTCPAY_URL)"
for _ in $(seq 1 60); do
  curl -sf "$BTCPAY_URL/api/v1/health" | grep -q '"synchronized":true' && break
  sleep 3
done
curl -sf "$BTCPAY_URL/api/v1/health" | grep -q '"synchronized":true' || {
  log "同期しません。README の「Docker を再起動したとき」を参照してください"
  exit 1
}

# 2. 管理者（最初のユーザーだけは認証なしで作れる。作成済みなら拒否される）
if curl -sf -X POST "$BTCPAY_URL/api/v1/users" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"isAdministrator\":true}" >/dev/null; then
  log "管理者を作成した"
else
  log "管理者は作成済み"
fi

# API キー。前回の値が使えればそのまま使う。
# BTCPay 2.4 系では、アカウント作成から5分たつと Basic 認証が無効になるので、新しいキーは作成直後にしか作れない
API_KEY=""
[[ -f $ENV_FILE ]] && API_KEY=$(sed -n 's/^BTCPAY_API_KEY=//p' "$ENV_FILE")
if [[ -z $API_KEY ]] || ! curl -sf "$BTCPAY_URL/api/v1/users/me" -H "Authorization: token $API_KEY" >/dev/null; then
  if ! API_KEY=$(curl -sf -u "$ADMIN_EMAIL:$ADMIN_PASSWORD" -X POST "$BTCPAY_URL/api/v1/api-keys" \
    -H 'Content-Type: application/json' -d '{"label":"regtest-dev","permissions":["unrestricted"]}' | jq -er .apiKey); then
    log "API キーを作れません（作成から5分たつと Basic 認証が無効になる）。次のどちらかで対処してください"
    log "  - docker compose -f infra/regtest/docker-compose.yml down -v で作り直してから、もう一度実行する"
    log "  - 管理画面（${BTCPAY_URL}）の Account → API Keys で権限 unrestricted のキーを作り、${ENV_FILE} に BTCPAY_API_KEY=<キー> と書いてから実行する"
    exit 1
  fi
  log "API キーを作成した"
fi

# ストア（ADR 9・10: JPY、1 conf、支払い許容誤差 0%、期限 60秒）
STORE_SETTINGS='{"name":"'"$STORE_NAME"'","defaultCurrency":"JPY","speedPolicy":"MediumSpeed","paymentTolerance":0,"invoiceExpiration":60,"monitoringExpiration":300}'
STORE_ID=$(api GET /api/v1/stores | jq -r --arg n "$STORE_NAME" '[.[] | select(.name == $n)][0].id // empty')
if [[ -n $STORE_ID ]]; then
  api PUT "/api/v1/stores/$STORE_ID" "$STORE_SETTINGS" >/dev/null
  log "ストアは作成済み。設定を上書きした ($STORE_ID)"
else
  STORE_ID=$(api POST /api/v1/stores "$STORE_SETTINGS" | jq -r .id)
  log "ストアを作成した ($STORE_ID)"
fi

# 固定レート
api PUT "/api/v1/stores/$STORE_ID/rates/configuration/primary" \
  "{\"isCustomScript\":true,\"effectiveScript\":\"$RATE_SCRIPT\"}" >/dev/null
log "固定レートを設定した ($RATE_SCRIPT)"

# ウォレット（v2 系のパス）
WALLET_COUNT=$(api GET "/api/v1/stores/$STORE_ID/payment-methods" | jq '[.[] | select(.paymentMethodId == "BTC-CHAIN")] | length')
if [[ $WALLET_COUNT -gt 0 ]]; then
  log "ウォレットは作成済み"
else
  api POST "/api/v1/stores/$STORE_ID/payment-methods/BTC-CHAIN/wallet/generate" \
    '{"savePrivateKeys":true,"scriptPubKeyType":"Segwit","importKeysToRPC":true}' >/dev/null
  log "ウォレットを作成した"
fi

# 3. Webhook。secret は作成時にしか返らないので、前回の secret がなければ作り直す
WEBHOOK_SECRET=""
[[ -f $ENV_FILE ]] && WEBHOOK_SECRET=$(sed -n 's/^BTCPAY_WEBHOOK_SECRET=//p' "$ENV_FILE")
WEBHOOK_ID=$(api GET "/api/v1/stores/$STORE_ID/webhooks" | jq -r --arg u "$WEBHOOK_URL" '[.[] | select(.url == $u)][0].id // empty')
if [[ -n $WEBHOOK_ID && -n $WEBHOOK_SECRET ]]; then
  log "Webhook は作成済み ($WEBHOOK_URL)"
else
  [[ -n $WEBHOOK_ID ]] && api DELETE "/api/v1/stores/$STORE_ID/webhooks/$WEBHOOK_ID" >/dev/null
  WEBHOOK_SECRET=$(api POST "/api/v1/stores/$STORE_ID/webhooks" \
    "{\"url\":\"$WEBHOOK_URL\",\"enabled\":true,\"automaticRedelivery\":true,\"authorizedEvents\":{\"everything\":true}}" | jq -r .secret)
  log "Webhook を作成した ($WEBHOOK_URL)"
fi

cat >"$ENV_FILE" <<EOF
BTCPAY_URL=$BTCPAY_URL
BTCPAY_API_KEY=$API_KEY
BTCPAY_STORE_ID=$STORE_ID
BTCPAY_WEBHOOK_SECRET=$WEBHOOK_SECRET
EOF
log "完了。値は infra/regtest/${ENV_FILE} に書き出した"
