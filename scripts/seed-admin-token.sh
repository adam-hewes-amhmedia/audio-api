#!/usr/bin/env bash
# Bootstrap an admin token for the ops console.
#
# This is the only way an admin token comes into existence: there is no
# ADMIN_TOKEN env fallback and no self-service endpoint, because either would be
# an unrevocable, unattributable key to every tenant's data. Bootstrapping is
# deliberately a thing you do at the database, on purpose, once.
#
# Same hashing as scripts/seed-token.sh (sha256 hex) because admin-auth.ts
# mirrors auth.ts. Prefix is 'ad_' so an admin token is distinguishable at a
# glance from a tenant 'at_' token in a log or a paste.
set -euo pipefail
TOKEN="${1:-ad_$(openssl rand -hex 32)}"
HASH=$(printf '%s' "$TOKEN" | shasum -a 256 | awk '{print $1}')
docker compose -f "$(dirname "$0")/../infra/docker-compose.yml" exec -T postgres \
  psql -U audio -d audio -c \
  "INSERT INTO admin_tokens (id, token_hash, name) VALUES ('adm_dev', '$HASH', 'dev-console') ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, revoked_at = NULL;"
echo "ADMIN_TOKEN=$TOKEN"
echo "Store this now. Only the hash is kept, so it cannot be recovered later."
