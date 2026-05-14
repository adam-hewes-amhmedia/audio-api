#!/usr/bin/env bash
set -euo pipefail
TOKEN="${1:-dev-token-$(openssl rand -hex 16)}"
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}')
docker compose -f "$(dirname "$0")/../infra/docker-compose.yml" exec -T postgres \
  psql -U audio -d audio -c \
  "INSERT INTO api_tokens (id, tenant_id, token_hash, name) VALUES ('t_dev', 'tenant_dev', '$HASH', 'dev') ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash;"
echo "TOKEN=$TOKEN"
