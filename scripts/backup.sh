#!/usr/bin/env bash
# Helmet Platform backup: PostgreSQL (pg_dump custom format) + uploaded files + manifest.
#
#   sudo -u helmetdeploy /opt/helmet-platform/scripts/backup.sh
#
# Run daily by deploy/systemd/helmet-backup.timer. Configuration (all optional) is read from
# /etc/helmet-platform/backup.env (see deploy/env/backup.env.example).
#
# Guarantees:
#  - strict mode, every step checked; nothing is published unless the whole backup succeeded;
#  - files are created with umask 077 (owner-only), in a temp dir renamed into place (atomic);
#  - the DB password never appears in process arguments (pg_dump runs inside the postgres
#    container using its own environment / local socket);
#  - the manifest holds names, sizes, checksums and versions — never secrets;
#  - retention keeps KEEP_DAILY / KEEP_WEEKLY / KEEP_MONTHLY sets (hard links, no extra space);
#  - optional offsite copy via BACKUP_OFFSITE_CMD (e.g. rclone/rsync), reported separately.
#
# Backups on the same VPS do NOT protect against losing the VPS. Configure an offsite copy before
# a public launch (docs/DISASTER-RECOVERY.md). The env files with secrets and encryption keys are
# NOT included here — back those up separately and securely.
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
BACKUP_ROOT="${BACKUP_ROOT:-$DATA_ROOT/backups}"
TEXTFILE_DIR="${TEXTFILE_DIR:-$DATA_ROOT/node-exporter-textfile}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${KEEP_MONTHLY:-3}"
BACKUP_OFFSITE_CMD="${BACKUP_OFFSITE_CMD:-}"

compose() {
  if [ -n "${COMPOSE_CMD:-}" ]; then
    # shellcheck disable=SC2086
    $COMPOSE_CMD "$@"
  else
    COMPOSE_FILE="$COMPOSE_FILE" COMPOSE_ENV_FILE="$COMPOSE_ENV_FILE" "$COMPOSE_DIR/scripts/compose.sh" "$@"
  fi
}

log() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

write_metric() { # name value [help]
  [ -d "$TEXTFILE_DIR" ] || return 0
  local f="$TEXTFILE_DIR/helmet_backup.prom" tmp
  tmp="$(mktemp "$TEXTFILE_DIR/.helmet_backup.XXXXXX")"
  { [ -f "$f" ] && grep -v "^$1 \|^# .* $1 " "$f" || true; printf '# TYPE %s gauge\n%s %s\n' "$1" "$1" "$2"; } > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$f"
}

START=$(date +%s)
TS="$(date -u +%Y-%m-%dT%H%M%SZ)"
mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly" "$BACKUP_ROOT/monthly"
chmod 700 "$BACKUP_ROOT"

exec 9>"$BACKUP_ROOT/.lock"
flock -n 9 || die "another backup is running"

WORK="$BACKUP_ROOT/.tmp-$TS"
cleanup() {
  local code=$?
  rm -rf "$WORK"
  if [ $code -ne 0 ]; then
    write_metric helmet_backup_last_failure_timestamp_seconds "$(date +%s)"
    log "FAILED (exit $code); nothing was published"
  fi
}
trap cleanup EXIT
mkdir -m 700 "$WORK"

command -v docker >/dev/null || die "docker not found"
[ -d "$UPLOADS_DIR" ] || die "uploads directory $UPLOADS_DIR not found"

# ── 1. PostgreSQL ────────────────────────────────────────────────────────────────────────────
DB_FILE="helmet-$TS.dump"
log "dumping PostgreSQL → $DB_FILE"
compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner' \
  > "$WORK/$DB_FILE"
[ -s "$WORK/$DB_FILE" ] || die "empty database dump"
# Validate the archive (table of contents readable end to end).
compose exec -T postgres pg_restore --list < "$WORK/$DB_FILE" > "$WORK/db-toc.txt" || die "dump is not a valid archive"
DB_OBJECTS=$(grep -cv '^;' "$WORK/db-toc.txt" || true)
LATEST_MIGRATION=$(compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1"' | tr -d '\r')
PG_VERSION=$(compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SHOW server_version"' | tr -d '\r')
# Row counts of key tables (restore drills compare against these). Counts only — no data.
ROW_COUNTS=$(compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT json_build_object(
  '"'"'users'"'"', (SELECT count(*) FROM users),
  '"'"'helmets'"'"', (SELECT count(*) FROM helmets),
  '"'"'helmet_ownerships'"'"', (SELECT count(*) FROM helmet_ownerships),
  '"'"'emergency_profiles'"'"', (SELECT count(*) FROM emergency_profiles),
  '"'"'emergency_contacts'"'"', (SELECT count(*) FROM emergency_contacts),
  '"'"'helmet_warranties'"'"', (SELECT count(*) FROM helmet_warranties),
  '"'"'audit_logs'"'"', (SELECT count(*) FROM audit_logs),
  '"'"'helmet_scan_daily'"'"', (SELECT count(*) FROM helmet_scan_daily),
  '"'"'admin_users'"'"', (SELECT count(*) FROM admin_users))"' | tr -d '\r')

# ── 2. Uploaded files (profile photos, warranty proofs) ───────────────────────────────────────
if command -v zstd >/dev/null; then
  UP_FILE="uploads-$TS.tar.zst"; COMPRESS=(zstd -q -T0 -10)
else
  UP_FILE="uploads-$TS.tar.gz"; COMPRESS=(gzip -6)
fi
log "archiving uploads → $UP_FILE"
# Temp files from interrupted writes (*.tmp-*) and probe files are skipped.
tar -C "$UPLOADS_DIR" --exclude='*.tmp-*' --exclude='.write-probe-*' --exclude='./temp' --exclude='./quarantine' \
  --numeric-owner -cf - . | "${COMPRESS[@]}" > "$WORK/$UP_FILE"
UP_FILES=$(find "$UPLOADS_DIR" -type f ! -name '*.tmp-*' ! -name '.write-probe-*' | wc -l | tr -d ' ')

# ── 3. Manifest + checksums ───────────────────────────────────────────────────────────────────
APP_VERSION=$(compose exec -T api printenv APP_VERSION 2>/dev/null | tr -d '\r' || echo unknown)
GIT_SHA=$(compose exec -T api printenv GIT_SHA 2>/dev/null | tr -d '\r' || echo unknown)
( cd "$WORK" && sha256sum "$DB_FILE" "$UP_FILE" > SHA256SUMS )
cat > "$WORK/manifest.json" <<JSON
{
  "timestamp": "$TS",
  "hostname": "$(hostname -s)",
  "appVersion": "${APP_VERSION:-unknown}",
  "gitSha": "${GIT_SHA:-unknown}",
  "postgresVersion": "$PG_VERSION",
  "latestMigration": "$LATEST_MIGRATION",
  "rowCounts": $ROW_COUNTS,
  "database": { "file": "$DB_FILE", "bytes": $(stat -c %s "$WORK/$DB_FILE"), "sha256": "$(cut -d' ' -f1 <(grep " $DB_FILE\$" "$WORK/SHA256SUMS"))", "archiveObjects": $DB_OBJECTS },
  "uploads": { "file": "$UP_FILE", "bytes": $(stat -c %s "$WORK/$UP_FILE"), "sha256": "$(cut -d' ' -f1 <(grep " $UP_FILE\$" "$WORK/SHA256SUMS"))", "files": $UP_FILES },
  "notIncluded": ["application env files and secrets", "encryption keys", "TLS keys", "Redis (ephemeral)"]
}
JSON
rm -f "$WORK/db-toc.txt"

# ── 4. Publish atomically ─────────────────────────────────────────────────────────────────────
DEST="$BACKUP_ROOT/daily/$TS"
mv "$WORK" "$DEST"
trap - EXIT
log "published $DEST"
# Weekly (Sunday) and monthly (1st) sets are hard links to the daily set.
[ "$(date -u +%u)" = 7 ] && cp -al "$DEST" "$BACKUP_ROOT/weekly/$TS"
[ "$(date -u +%d)" = 01 ] && cp -al "$DEST" "$BACKUP_ROOT/monthly/$TS"

# ── 5. Retention ─────────────────────────────────────────────────────────────────────────────
prune() { # dir keep
  local dir=$1 keep=$2
  find "$dir" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort -r | tail -n +"$((keep + 1))" | while read -r old; do
    log "retention: removing $old"
    rm -rf -- "$old"
  done
}
prune "$BACKUP_ROOT/daily" "$KEEP_DAILY"
prune "$BACKUP_ROOT/weekly" "$KEEP_WEEKLY"
prune "$BACKUP_ROOT/monthly" "$KEEP_MONTHLY"

END=$(date +%s)
write_metric helmet_backup_last_success_timestamp_seconds "$END"
write_metric helmet_backup_last_duration_seconds "$((END - START))"
write_metric helmet_backup_last_size_bytes "$(du -sb "$DEST" | cut -f1)"

# ── 6. Optional offsite copy ─────────────────────────────────────────────────────────────────
if [ -n "$BACKUP_OFFSITE_CMD" ]; then
  log "offsite copy: running BACKUP_OFFSITE_CMD"
  if BACKUP_DIR="$DEST" BACKUP_TS="$TS" sh -c "$BACKUP_OFFSITE_CMD"; then
    write_metric helmet_backup_offsite_last_success_timestamp_seconds "$(date +%s)"
    log "offsite copy succeeded"
  else
    log "WARNING: offsite copy failed (local backup is intact)"
    exit 2
  fi
else
  log "WARNING: no BACKUP_OFFSITE_CMD configured — this backup exists only on this server"
fi
log "done in $((END - START))s"
