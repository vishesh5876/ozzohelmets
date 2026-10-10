#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into a Compose project. DANGEROUS by design:
# it replaces the target database and moves the current uploads aside.
#
#   scripts/restore.sh --backup /srv/helmet-platform/backups/daily/2026-10-10T020000Z \
#       [--db-only | --uploads-only] [--uploads-dir DIR] --confirm <project-name>
#
# Safety:
#  - verifies SHA256SUMS before touching anything;
#  - requires --confirm with the exact Compose project name (no interactive "yes" to fat-finger);
#  - stops api + worker first, so nothing writes during the restore;
#  - never deletes current uploads: they are moved to <uploads>.before-restore-<ts>;
#  - after the DB restore runs `prisma migrate deploy` (forward-only) so an older backup is
#    brought to the current schema, then starts api + worker and waits for readiness.
# Restore drills should target a separate project (COMPOSE_PROJECT_NAME=helmet-drill) with its own
# DATA_ROOT — never the production one. See docs/DISASTER-RECOVERY.md.
# shellcheck disable=SC2016  # $POSTGRES_* in single quotes is expanded INSIDE the container.
set -Eeuo pipefail
umask 077

CONFIG_FILE="${HELMET_BACKUP_CONFIG:-/etc/helmet-platform/backup.env}"
# shellcheck disable=SC1090
[ -f "$CONFIG_FILE" ] && . "$CONFIG_FILE"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$COMPOSE_DIR/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-/etc/helmet-platform/compose.env}"
# DATA_ROOT: explicit env > backup.env > compose.env > default.
if [ -z "${DATA_ROOT:-}" ] && [ -r "$COMPOSE_ENV_FILE" ]; then
  DATA_ROOT=$(sed -n 's/^DATA_ROOT=//p' "$COMPOSE_ENV_FILE" | tail -1)
fi
DATA_ROOT="${DATA_ROOT:-/srv/helmet-platform}"
UPLOADS_DIR="${UPLOADS_DIR:-$DATA_ROOT/uploads}"
APP_UID="${APP_UID:-1000}"

BACKUP=""; CONFIRM=""; DO_DB=1; DO_UPLOADS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP="$2"; shift 2 ;;
    --confirm) CONFIRM="$2"; shift 2 ;;
    --db-only) DO_UPLOADS=0; shift ;;
    --uploads-only) DO_DB=0; shift ;;
    --uploads-dir) UPLOADS_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

compose() {
  if [ -n "${COMPOSE_CMD:-}" ]; then
    # shellcheck disable=SC2086
    $COMPOSE_CMD "$@"
  else
    COMPOSE_FILE="$COMPOSE_FILE" COMPOSE_ENV_FILE="$COMPOSE_ENV_FILE" "$COMPOSE_DIR/scripts/compose.sh" "$@"
  fi
}
log() { printf '%s restore: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

[ -n "$BACKUP" ] && [ -d "$BACKUP" ] || die "--backup <directory> is required"
PROJECT=$(compose config --format json 2>/dev/null | sed -n 's/^ *"name": "\([^"]*\)".*/\1/p' | head -1)
[ -n "$PROJECT" ] || die "could not determine the Compose project name"
[ "$CONFIRM" = "$PROJECT" ] || die "refusing: pass --confirm $PROJECT to overwrite project '$PROJECT'"

log "verifying checksums in $BACKUP"
( cd "$BACKUP" && sha256sum --quiet -c SHA256SUMS ) || die "checksum mismatch — backup is corrupt"
DB_FILE=$(find "$BACKUP" -maxdepth 1 -name 'helmet-*.dump' | head -1)
UP_FILE=$(find "$BACKUP" -maxdepth 1 -name 'uploads-*.tar.*' | head -1)
[ $DO_DB = 0 ] || [ -n "$DB_FILE" ] || die "no database dump in $BACKUP"
[ $DO_UPLOADS = 0 ] || [ -n "$UP_FILE" ] || die "no uploads archive in $BACKUP"

log "stopping api and worker in project '$PROJECT'"
compose stop api worker >/dev/null 2>&1 || true

if [ $DO_DB = 1 ]; then
  compose up -d postgres >/dev/null
  for _ in $(seq 1 30); do compose exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -q' && break; sleep 2; done
  log "recreating database and restoring $(basename "$DB_FILE")"
  compose exec -T postgres sh -c '
    set -e
    psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -q \
      -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '"'"'$POSTGRES_DB'"'"' AND pid <> pg_backend_pid()" >/dev/null
    dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"
    createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"'
  compose exec -T postgres sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$DB_FILE"
  log "database restored"
fi

if [ $DO_UPLOADS = 1 ]; then
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  if [ -d "$UPLOADS_DIR" ] && [ -n "$(ls -A "$UPLOADS_DIR" 2>/dev/null)" ]; then
    log "moving current uploads aside → $UPLOADS_DIR.before-restore-$TS"
    mv "$UPLOADS_DIR" "$UPLOADS_DIR.before-restore-$TS"
  fi
  mkdir -p "$UPLOADS_DIR"
  case "$UP_FILE" in
    *.zst) zstd -dc "$UP_FILE" | tar -C "$UPLOADS_DIR" -xf - ;;
    *.gz) tar -C "$UPLOADS_DIR" -xzf "$UP_FILE" ;;
    *) die "unknown archive type: $UP_FILE" ;;
  esac
  # The API container runs as UID $APP_UID; files 0600, directories 0700.
  chown -R "$APP_UID:$APP_UID" "$UPLOADS_DIR" 2>/dev/null || log "note: could not chown (run as root or the owner)"
  find "$UPLOADS_DIR" -type d -exec chmod 700 {} + && find "$UPLOADS_DIR" -type f -exec chmod 600 {} +
  log "uploads restored ($(find "$UPLOADS_DIR" -type f | wc -l | tr -d ' ') files)"
fi

if [ $DO_DB = 1 ]; then
  log "applying any newer migrations (forward-only)"
  compose run --rm --no-deps api ./node_modules/.bin/prisma migrate deploy
fi

log "starting api and worker"
compose up -d api worker >/dev/null
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q api | head -1)" 2>/dev/null)" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q api | head -1)")" = healthy ] || die "api did not become healthy"
log "restore complete; api healthy. Verify with the checks in docs/DISASTER-RECOVERY.md."
