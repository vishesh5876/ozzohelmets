#!/usr/bin/env bash
# docker compose for the production stack with the right files, always:
#   compose file  : docker-compose.prod.yml (this checkout)
#   env files     : /etc/helmet-platform/compose.env, then the deployed release
#                   (<DATA_ROOT>/deploy-state/release.env, written by deploy-vps.sh) — so a manual
#                   `up -d` never silently starts an older image than the one deployed.
# Usage: scripts/compose.sh ps | logs -f api | exec api node dist/cli.js encryption:status | …
set -euo pipefail
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$COMPOSE_DIR/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-/etc/helmet-platform/compose.env}"
if [ -z "${RELEASE_ENV_FILE:-}" ]; then
  data_root=$(sed -n 's/^DATA_ROOT=//p' "$COMPOSE_ENV_FILE" 2>/dev/null | tail -1)
  RELEASE_ENV_FILE="${data_root:-/srv/helmet-platform}/deploy-state/release.env"
fi
args=(-f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE")
[ -r "$RELEASE_ENV_FILE" ] && args+=(--env-file "$RELEASE_ENV_FILE")
exec docker compose "${args[@]}" "$@"
