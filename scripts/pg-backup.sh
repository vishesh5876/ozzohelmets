#!/usr/bin/env bash
# Ozzo Helmets: local backup for the PM2 / aaPanel deployment (host PostgreSQL, no Docker).
# Writes a pg_dump custom-format dump of database "ozzo" + a tarball of the uploads directory to
# $BACKUP_DIR/<timestamp>/ with SHA-256 sums, then prunes sets older than $RETENTION_DAYS.
#
#   sudo -u ozzo /opt/ozzohelmets/scripts/pg-backup.sh
#
# LOCAL ONLY: copy $BACKUP_DIR offsite (OFFSITE BACKUP REQUIRED FOR PRODUCTION). The dump is useless
# for medical fields without DATA_ENCRYPTION_KEYS: back up /etc/helmet-platform separately.
# Restore: docs/PM2-DEPLOYMENT.md#restore (never onto the production DB without confirmation).
set -Eeuo pipefail
umask 077

ENV_FILE="${OZZO_ENV_FILE:-/etc/helmet-platform/app.env}"
BACKUP_DIR="${OZZO_BACKUP_DIR:-/srv/helmet-platform/backups}"
UPLOADS_DIR="${OZZO_UPLOADS_DIR:-/srv/helmet-platform/uploads}"
RETENTION_DAYS="${OZZO_BACKUP_RETENTION_DAYS:-14}"
PG_BIN="${PG_BIN:-/www/server/pgsql/bin}"

url="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE")"
[ -n "$url" ] || { echo "DATABASE_URL missing in $ENV_FILE" >&2; exit 1; }
# libpq rejects Prisma-only query parameters (schema, connection_limit, pool_timeout).
url="${url%%\?*}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$BACKUP_DIR/$stamp"
mkdir -p "$dest"
trap 'rc=$?; [ $rc -ne 0 ] && rm -rf "$dest"; exit $rc' EXIT

"$PG_BIN/pg_dump" --format=custom --compress=6 --no-owner --no-privileges \
  --file="$dest/ozzo.dump" "$url"
"$PG_BIN/pg_restore" --list "$dest/ozzo.dump" >/dev/null   # dump is readable

tar -C "$(dirname "$UPLOADS_DIR")" -czf "$dest/uploads.tar.gz" "$(basename "$UPLOADS_DIR")"

(cd "$dest" && sha256sum ozzo.dump uploads.tar.gz > SHA256SUMS)
git_sha="$(git -C "$(dirname "$0")/.." rev-parse HEAD 2>/dev/null || echo unknown)"
printf 'created=%s\ngit_sha=%s\n' "$stamp" "$git_sha" > "$dest/MANIFEST"

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime +"$RETENTION_DAYS" \
  -exec rm -rf {} +

echo "backup ok: $dest ($(du -sh "$dest" | cut -f1))"
