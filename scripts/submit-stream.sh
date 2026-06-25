#!/usr/bin/env bash
set -euo pipefail
API="${API_URL:-http://localhost:8080}"
TOKEN="${DEV_TOKEN:-test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
SOURCE_KIND="${SOURCE_KIND:-hls}"
SOURCE_URL="${SOURCE_URL:-https://fixtures.invalid/skeleton.m3u8}"

RESP=$(curl -s -X POST "$API/v1/streams" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d "{\"source\":{\"kind\":\"$SOURCE_KIND\",\"url\":\"$SOURCE_URL\"},\"source_hint\":\"fr\",\"output\":{\"target_lang\":\"en\"}}")

echo "$RESP" | (command -v jq >/dev/null && jq . || cat)

WS=$(echo "$RESP" | python -c "import sys,json; print(json.load(sys.stdin)['outputs']['websocket_url'])")
ID=$(echo "$RESP" | python -c "import sys,json; print(json.load(sys.stdin)['stream_id'])")
echo
echo "Stream id: $ID"
echo "WS:        $WS"
echo "Auth:      Bearer $TOKEN"
