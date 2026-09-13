#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
USER_TOKEN="${USER_TOKEN:-user-a}"
CORRELATION_ID="${CORRELATION_ID:-smoke-$(date +%s)}"

echo "health:"
curl -fsS "$BASE_URL/healthz"
echo

echo "wallet create:"
wallet_response="$(
  curl -fsS \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "X-Correlation-Id: $CORRELATION_ID-wallet" \
    -X POST \
    "$BASE_URL/wallets"
)"
echo "$wallet_response"
echo

echo "wallet read:"
wallet_id="$(node -e "const input = process.argv[1]; console.log(JSON.parse(input).wallet_id)" "$wallet_response")"
curl -fsS \
  -H "Authorization: Bearer $USER_TOKEN" \
  "$BASE_URL/wallets/$wallet_id"
echo

echo "transfer create:"
transfer_response="$(
  curl -fsS \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -H "X-Correlation-Id: $CORRELATION_ID-transfer" \
    -d '{"from":"wallet_a","to":"wallet_b","amount_paise":100,"idempotency_key":"smoke-key"}' \
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
