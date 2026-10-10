#!/usr/bin/env bash
# Restore drill: restores a backup into an ISOLATED Compose project ("helmet-drill": own data
# directory, network and database — production is never touched), boots the API and worker,
# compares row counts with the backup manifest and runs every worker job once.
#
#   scripts/restore-drill.sh --backup /srv/helmet-platform/backups/daily/<ts> [--drill-root /srv/helmet-drill]
#
# Uses the production env files for keys (the encryption keys must match the backup, which is
# exactly what a drill proves). Leaves the drill running for manual checks; stop it with
#   docker compose -p helmet-drill -f docker-compose.prod.yml --env-file <drill-root>/compose.env down
# and delete <drill-root> afterwards. Run it monthly and before every launch.
set -Eeuo pipefail
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
export COMPOSE_DIR
PROD_ENV="${COMPOSE_ENV_FILE:-/etc/helmet-platform/compose.env}"
DRILL_ROOT="/srv/helmet-drill"; BACKUP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP="$2"; shift 2 ;;
    --drill-root) DRILL_ROOT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
log() { printf '%s drill: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }
[ -f "$BACKUP/manifest.json" ] || die "--backup must point at a backup set (manifest.json missing)"
case "$DRILL_ROOT" in *drill*) ;; *) die "--drill-root must contain 'drill' (safety)";; esac
[ ! -e "$DRILL_ROOT/data/postgres/PG_VERSION" ] || die "$DRILL_ROOT already holds a drill database; remove it first"

# Drill compose.env: production values (env files, deployed image version) + isolated
# project/data/network.
mkdir -p "$DRILL_ROOT"
PROD_DATA_ROOT=$(sed -n 's/^DATA_ROOT=//p' "$PROD_ENV" | tail -1)
PROD_RELEASE="${PROD_DATA_ROOT:-/srv/helmet-platform}/deploy-state/release.env"
{ grep -vE '^(COMPOSE_PROJECT_NAME|DATA_ROOT|EDGE_SUBNET|HTTP_BIND|HTTPS_BIND|APP_VERSION|GIT_SHA)=' "$PROD_ENV"
  if [ -r "$PROD_RELEASE" ]; then cat "$PROD_RELEASE"; else grep -E '^APP_VERSION=' "$PROD_ENV" || true; fi
} > "$DRILL_ROOT/compose.env"
cat >> "$DRILL_ROOT/compose.env" <<ENV
COMPOSE_PROJECT_NAME=helmet-drill
DATA_ROOT=$DRILL_ROOT/data
EDGE_SUBNET=172.31.250.0/24
ENV
chmod 600 "$DRILL_ROOT/compose.env"
install -d -m 700 -o 70 -g 70 "$DRILL_ROOT/data/postgres"
install -d -m 700 -o 999 -g 999 "$DRILL_ROOT/data/redis"
install -d -m 700 -o 1000 -g 1000 "$DRILL_ROOT/data/uploads"
export COMPOSE_ENV_FILE="$DRILL_ROOT/compose.env" DATA_ROOT="$DRILL_ROOT/data" UPLOADS_DIR="$DRILL_ROOT/data/uploads"
export RELEASE_ENV_FILE=/nonexistent   # the drill's compose.env already pins the version
compose() { "$COMPOSE_DIR/scripts/compose.sh" "$@"; }

log "starting empty drill datastores"
compose up -d --wait postgres redis
START=$(date +%s)
HELMET_BACKUP_CONFIG=/dev/null "$COMPOSE_DIR/scripts/restore.sh" --backup "$BACKUP" --confirm helmet-drill
log "restore finished in $(( $(date +%s) - START ))s"

log "comparing row counts with the manifest"
EXPECTED=$(sed -n 's/.*"rowCounts": \({[^}]*}\).*/\1/p' "$BACKUP/manifest.json")
FAIL=0
for table in users helmets helmet_ownerships emergency_profiles emergency_contacts helmet_warranties audit_logs helmet_scan_daily admin_users; do
  want=$(printf '%s' "$EXPECTED" | grep -o "\"$table\" *: *[0-9]*" | grep -o '[0-9]*$' || echo "?")
  got=$(compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc 'SELECT count(*) FROM $table'" | tr -d '\r')
  if [ "$want" = "$got" ]; then log "  ✓ $table: $got"; else log "  ✗ $table: expected $want, got $got"; FAIL=1; fi
done
want_files=$(sed -n 's/.*"files": \([0-9]*\).*/\1/p' "$BACKUP/manifest.json")
got_files=$(find "$UPLOADS_DIR" -type f | wc -l | tr -d ' ')
if [ "$want_files" = "$got_files" ]; then log "  ✓ upload files: $got_files"; else log "  ✗ upload files: expected $want_files, got $got_files"; FAIL=1; fi

log "readiness and worker jobs"
compose exec -T api node -e "fetch('http://127.0.0.1:4000/api/v1/health/ready').then(async r=>{console.log('  readiness',r.status,await r.text());process.exit(r.ok?0:1)})" || FAIL=1
compose run --rm --no-deps -e LOG_LEVEL=info worker node dist/worker.js --once all 2>&1 | grep -oE '(analytics.aggregate|risk.evaluate|retention.cleanup): [A-Z]+' | sed 's/^/  /'
compose exec -T api node dist/cli.js encryption:status | tr -d '\n' | sed 's/  */ /g; s/^/  encryption key versions in use: /'; echo
[ $FAIL = 0 ] || die "DRILL FAILED — see ✗ lines above"
log "DRILL PASSED in $(( $(date +%s) - START ))s (RTO data point). Drill stack left running for manual checks."
