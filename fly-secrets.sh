#!/usr/bin/env bash
# Push STONPOOL_* secrets to the fly api app from a local env file, rewriting the
# Postgres URL to the async driver the app expects.
#
#   fly pg attach stonpool-db -a stonpool-api   # sets DATABASE_URL on the app
#   ./fly-secrets.sh [.env.fly] [stonpool-api]
set -euo pipefail

ENV_FILE="${1:-.env.fly}"
APP="${2:-stonpool-api}"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }

# fly pg attach exposes DATABASE_URL as postgres://; sqlalchemy[asyncio] needs postgresql+asyncpg://
DATABASE_URL="$(fly ssh console -a "$APP" -C 'printenv DATABASE_URL' 2>/dev/null | tr -d '\r' || true)"
ASYNC_URL=""
if [ -n "$DATABASE_URL" ]; then
  ASYNC_URL="${DATABASE_URL/postgres:\/\//postgresql+asyncpg://}"
  ASYNC_URL="${ASYNC_URL/postgresql:\/\//postgresql+asyncpg://}"
fi

ARGS=()
while IFS='=' read -r key val; do
  case "$key" in ''|\#*) continue;; esac
  [ -z "$val" ] && continue
  ARGS+=("$key=$val")
done < "$ENV_FILE"

[ -n "$ASYNC_URL" ] && ARGS+=("STONPOOL_DATABASE_URL=$ASYNC_URL")

[ ${#ARGS[@]} -eq 0 ] && { echo "nothing to set"; exit 0; }
fly secrets set -a "$APP" "${ARGS[@]}"