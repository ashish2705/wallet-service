#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
USER_TOKEN="${USER_TOKEN:-user-a}"
ADMIN_TOKEN="${ADMIN_TOKEN:-dev-admin-token}"
CORRELATION_ID="${CORRELATION_ID:-smoke-$(date +%s)}"

echo "health:"
curl -fsS "$BASE_URL/healthz"
echo

echo "seed sender wallet:"
wallet_response="$(
  curl -fsS \
    -H "X-Admin-Token: $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Correlation-Id: $CORRELATION_ID-wallet" \
    -d '{"user_id":"user-a","balance_paise":10000}' \
    "$BASE_URL/admin/seed"
)"
echo "$wallet_response"
echo

echo "seed recipient wallet:"
recipient_response="$(
  curl -fsS \
    -H "X-Admin-Token: $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Correlation-Id: $CORRELATION_ID-recipient" \
    -d '{"user_id":"user-b","balance_paise":0}' \
    "$BASE_URL/admin/seed"
)"
echo "$recipient_response"
echo

echo "wallet read:"
wallet_id="$(node -e "const input = process.argv[1]; console.log(JSON.parse(input).wallet_id)" "$wallet_response")"
curl -fsS \
  -H "Authorization: Bearer $USER_TOKEN" \
  "$BASE_URL/wallets/$wallet_id"
echo

echo "transfer create:"
recipient_id="$(node -e "const input = process.argv[1]; console.log(JSON.parse(input).wallet_id)" "$recipient_response")"
transfer_response="$(
  curl -fsS \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Correlation-Id: $CORRELATION_ID-transfer" \
    -d "{\"from\":\"$wallet_id\",\"to\":\"$recipient_id\",\"amount_paise\":100,\"idempotency_key\":\"$CORRELATION_ID-key\"}" \
    "$BASE_URL/transfers"
)"
echo "$transfer_response"
echo

echo "transfer read:"
transfer_id="$(node -e "const input = process.argv[1]; console.log(JSON.parse(input).transfer_id)" "$transfer_response")"
curl -fsS \
  -H "Authorization: Bearer $USER_TOKEN" \
  "$BASE_URL/transfers/$transfer_id"
echo

echo "metrics:"
curl -fsS "$BASE_URL/metrics" | grep -E "^(http_requests_total|wallet_transfers_created_total)"
