#!/usr/bin/env bash
# Deploy (or roll back) the Helmet Platform on the VPS. Run as the deployment user from the
# checkout (/opt/helmet-platform). Never deletes volumes, never resets or pushes the schema.
#
#   scripts/deploy-vps.sh                      # build current checkout, backup, migrate, restart
#   scripts/deploy-vps.sh --ref v1.2.0         # check out a tag/commit first (clean tree required)
#   scripts/deploy-vps.sh --pull               # pull prebuilt images (IMAGE_PREFIX/APP_VERSION) instead of building
#   scripts/deploy-vps.sh --no-build           # use images already present locally (e.g. `docker load` of CI artifacts)
#   scripts/deploy-vps.sh --rollback v1.1.0    # restart on previously deployed images; no migration
#   scripts/deploy-vps.sh --skip-backup        # only when a fresh backup was just taken
#
# Steps: preflight → (checkout) → backup → build/pull → start datastores → migrate deploy →
# start api/worker/admin/portal/edge → wait healthy → smoke checks → record release.
set -Eeuo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$COMPOSE_DIR/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-/etc/helmet-platform/compose.env}"
STATE_DIR="${STATE_DIR:-/srv/helmet-platform/deploy-state}"
REF=""; PULL=0; NO_BUILD=0; ROLLBACK=""; SKIP_BACKUP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --pull) PULL=1; shift ;;
    --no-build) NO_BUILD=1; shift ;;
    --rollback) ROLLBACK="$2"; shift 2 ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1m%s deploy:\033[0m %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
compose() { docker compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" "$@"; }
export COMPOSE_FILE COMPOSE_ENV_FILE COMPOSE_DIR

# ── Preflight ─────────────────────────────────────────────────────────────────────────────────
[ "$(id -u)" != 0 ] || log "warning: running as root; prefer the deployment user (docker group)"
command -v docker >/dev/null || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
[ -f "$COMPOSE_ENV_FILE" ] || die "missing $COMPOSE_ENV_FILE (see deploy/env/compose.env.example)"
set -a
# shellcheck disable=SC1090
. "$COMPOSE_ENV_FILE"
set +a
for f in "${APP_ENV_FILE:-/etc/helmet-platform/app.env}" "${POSTGRES_ENV_FILE:-/etc/helmet-platform/postgres.env}" \
         "${TLS_DIR:-/etc/helmet-platform/tls}/origin.crt" "${TLS_DIR:-/etc/helmet-platform/tls}/origin.key"; do
  [ -r "$f" ] || die "missing or unreadable: $f"
done
for f in "${APP_ENV_FILE:-/etc/helmet-platform/app.env}" "${POSTGRES_ENV_FILE:-/etc/helmet-platform/postgres.env}"; do
  perm=$(stat -c %a "$f")
  [ "${perm: -1}" = 0 ] || die "$f is world-accessible (mode $perm); chmod 600 it"
done
DATA_ROOT="${DATA_ROOT:-/srv/helmet-platform}"
for d in postgres redis uploads backups; do [ -d "$DATA_ROOT/$d" ] || die "missing $DATA_ROOT/$d (run scripts/vps-prepare.sh)"; done
compose config -q || die "docker-compose.prod.yml does not validate with $COMPOSE_ENV_FILE"
mkdir -p "$STATE_DIR"

# ── Version ───────────────────────────────────────────────────────────────────────────────────
cd "$COMPOSE_DIR"
if [ -n "$ROLLBACK" ]; then
  export APP_VERSION="$ROLLBACK"
  for img in api admin portal; do
    docker image inspect "${IMAGE_PREFIX:-helmet}/$img:$APP_VERSION" >/dev/null 2>&1 \
      || [ $PULL = 1 ] || die "image ${IMAGE_PREFIX:-helmet}/$img:$APP_VERSION not found locally (use --pull)"
  done
  log "ROLLBACK to $APP_VERSION (no migration: the database stays on the newer schema — migrations are additive/forward-only)"
else
  if [ -n "$REF" ]; then
    [ -z "$(git status --porcelain)" ] || die "working tree not clean; refusing to check out $REF"
    git fetch --tags --quiet origin
    git checkout --quiet --detach "$REF"
  fi
  APP_VERSION="${APP_VERSION_OVERRIDE:-$(git describe --tags --always --dirty 2>/dev/null || echo local)}"
  export APP_VERSION
  GIT_SHA="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
  BUILD_DATE="$(date -u +%FT%TZ)"
  export GIT_SHA BUILD_DATE
  log "deploying $APP_VERSION ($GIT_SHA)"
fi
PREVIOUS="$(tail -n1 "$STATE_DIR/releases.log" 2>/dev/null | awk '{print $2}' || true)"

# ── Backup ───────────────────────────────────────────────────────────────────────────────────
if [ $SKIP_BACKUP = 0 ] && [ -n "$(compose ps -q postgres 2>/dev/null)" ]; then
  log "taking a pre-deploy backup"
  BACKUP_OFFSITE_CMD="${BACKUP_OFFSITE_CMD:-}" "$COMPOSE_DIR/scripts/backup.sh" || {
    rc=$?
    if [ $rc = 2 ]; then log "warning: offsite copy failed; local backup OK"; else die "backup failed — not deploying"; fi
  }
fi

# ── Images ───────────────────────────────────────────────────────────────────────────────────
if [ $PULL = 1 ]; then
  log "pulling images"
  compose pull api worker admin portal
elif [ $NO_BUILD = 1 ]; then
  for img in api admin portal; do
    docker image inspect "${IMAGE_PREFIX:-helmet}/$img:$APP_VERSION" >/dev/null 2>&1 \
      || die "--no-build: image ${IMAGE_PREFIX:-helmet}/$img:$APP_VERSION not found locally"
  done
  log "using local images ${IMAGE_PREFIX:-helmet}/*:$APP_VERSION"
elif [ -z "$ROLLBACK" ]; then
  log "building images (api/worker share one image)"
  compose build api admin portal
fi

# ── Datastores + migration ───────────────────────────────────────────────────────────────────
log "starting postgres and redis"
compose up -d --wait postgres redis
if [ -z "$ROLLBACK" ]; then
  log "applying migrations (prisma migrate deploy — forward-only)"
  compose run --rm --no-deps api ./node_modules/.bin/prisma migrate deploy
fi

# ── Application ──────────────────────────────────────────────────────────────────────────────
log "starting api, worker, admin, portal, edge"
compose up -d --wait api
compose up -d --wait worker admin portal edge
[ -n "${API_REPLICAS:-}" ] && log "api replicas: $API_REPLICAS"

# ── Smoke checks through the edge (origin cert → -k for this local check only) ───────────────
PORTAL="${PORTAL_DOMAIN:?}"; ADMIN="${ADMIN_DOMAIN:?}"
check() { # description expected-status url host
  local got
  got=$(curl -sk --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$4:443:127.0.0.1" "$3" || echo 000)
  if [ "$got" = "$2" ]; then log "  ✓ $1 ($got)"; else log "  ✗ $1 (expected $2, got $got)"; return 1; fi
}
log "smoke checks"
FAIL=0
check "API readiness"                         200 "https://$PORTAL/api/v1/health/ready" "$PORTAL" || FAIL=1
check "emergency page shell"                  200 "https://$PORTAL/e/AAAAAAAAAAAAAAAAAAAAAA" "$PORTAL" || FAIL=1
check "unknown QR token → 404"                404 "https://$PORTAL/api/v1/public/emergency/AAAAAAAAAAAAAAAAAAAAAA" "$PORTAL" || FAIL=1
check "admin console"                         200 "https://$ADMIN/" "$ADMIN" || FAIL=1
check "metrics not public"                    404 "https://$PORTAL/api/v1/internal/metrics" "$PORTAL" || FAIL=1
redirect=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $PORTAL" http://127.0.0.1/ || echo 000)
if [ "$redirect" = 301 ]; then log "  ✓ HTTP redirects to HTTPS (301)"; else log "  ✗ HTTP redirect (got $redirect)"; FAIL=1; fi

VERSION_RUNNING="$(compose exec -T api printenv APP_VERSION | tr -d '\r')"
SHA_RUNNING="$(compose exec -T api printenv GIT_SHA | tr -d '\r')"
if [ $FAIL = 1 ]; then
  log "SMOKE CHECKS FAILED for $VERSION_RUNNING. Previous release: ${PREVIOUS:-none}."
  log "Roll back with: scripts/deploy-vps.sh --rollback ${PREVIOUS:-<version>}"
  exit 1
fi
printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$VERSION_RUNNING" "$SHA_RUNNING" >> "$STATE_DIR/releases.log"
log "deployed $VERSION_RUNNING ($SHA_RUNNING). Previous: ${PREVIOUS:-none}."
log "keep the previous images for rollback; prune older ones with: docker image prune --filter until=720h"
