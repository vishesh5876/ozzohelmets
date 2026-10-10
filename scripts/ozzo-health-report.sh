#!/usr/bin/env bash
# Read-only production health report for the PM2 / aaPanel deployment (docs/PM2-DEPLOYMENT.md).
# Run as root on the VPS and paste the output into the ops log or the Phase 8 review:
#
#   sudo /opt/ozzohelmets/scripts/ozzo-health-report.sh 2>&1 | tee /tmp/ozzo-health.txt
#
# It never changes data, never restarts anything and never prints secrets (the database and
# Redis credentials are read from app.env and passed through the environment, not echoed).
# Sections: version, processes, health, migrations, worker, backups, disk, database, Redis,
# logs (last 24 h), host resources.
set -uo pipefail

APP_DIR="${OZZO_APP_DIR:-/opt/ozzohelmets}"
ENV_FILE="${OZZO_ENV_FILE:-/etc/helmet-platform/app.env}"
DATA_ROOT="${OZZO_DATA_ROOT:-/srv/helmet-platform}"
BACKUP_DIR="${OZZO_BACKUP_DIR:-$DATA_ROOT/backups}"
LOG_DIR="${OZZO_LOG_DIR:-/var/log/ozzohelmets}"
NGINX_LOGS="${OZZO_NGINX_LOGS:-/www/wwwlogs}"
PG_BIN="${PG_BIN:-/www/server/pgsql/bin}"
API_PORT="${OZZO_API_PORT:-4100}"

section() { printf '\n== %s ==\n' "$*"; }
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed 's/^"//; s/"$//'; }

[ -r "$ENV_FILE" ] || { echo "cannot read $ENV_FILE (run as root)"; exit 1; }
DB_URL="$(envval DATABASE_URL)"; DB_URL="${DB_URL%%\?*}"
REDIS_URL="$(envval REDIS_URL)"
psqlq() { "$PG_BIN/psql" "$DB_URL" -X -A -t -F ' | ' -c "$1" 2>&1; }
psqlt() { "$PG_BIN/psql" "$DB_URL" -X -P pager=off -c "$1" 2>&1; }
# redis://[:password@]host:port[/db] → host, port, password (password only via REDISCLI_AUTH)
r_rest="${REDIS_URL#*://}"; r_auth=""; [[ "$r_rest" == *@* ]] && { r_auth="${r_rest%%@*}"; r_rest="${r_rest#*@}"; }
r_auth="${r_auth#*:}"; r_hostport="${r_rest%%/*}"; R_HOST="${r_hostport%%:*}"; R_PORT="${r_hostport##*:}"
redisq() {
  # LATENCY_TIMEOUT: stop a sampling command with SIGINT so redis-cli prints its summary.
  local t=(); [ -n "${LATENCY_TIMEOUT:-}" ] && t=(timeout -s INT "$LATENCY_TIMEOUT")
  if [ -n "$r_auth" ]; then
    REDISCLI_AUTH="$r_auth" "${t[@]}" redis-cli --no-auth-warning -h "$R_HOST" -p "$R_PORT" "$@" 2>&1
  else
    "${t[@]}" redis-cli -h "$R_HOST" -p "$R_PORT" "$@" 2>&1
  fi
}

section "Report"
date -u +"generated %Y-%m-%dT%H:%M:%SZ"; hostname

section "Version"
echo "git: $(git -C "$APP_DIR" rev-parse --short=12 HEAD 2>/dev/null) ($(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)) $(git -C "$APP_DIR" describe --tags --always 2>/dev/null)"
echo "deployed SPA releases: $(find "$DATA_ROOT/www/releases" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | sort | tail -3 | tr '\n' ' ')"

section "Processes (PM2, user ozzo)"
sudo -u ozzo -H pm2 ls 2>&1 | grep -E "name|ozzo-" || echo "pm2 not reachable for user ozzo"
systemctl is-active pm2-ozzo redis-server 2>&1 | paste -sd' ' | sed 's/^/systemd pm2-ozzo, redis-server: /'

section "Health"
curl -s -m 5 "http://127.0.0.1:$API_PORT/api/v1/health/ready"; echo
curl -s -m 5 -o /dev/null -w 'public readiness via Cloudflare: %{http_code} in %{time_total}s\n' https://ozzohelmets.cloud/api/v1/health/ready

section "Migrations"
psqlq "SELECT count(*) || ' applied, latest ' || max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL"
psqlq "SELECT 'UNFINISHED/FAILED: ' || migration_name FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL"
echo "repo migrations: $(find "$APP_DIR/apps/api/prisma/migrations" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' | wc -l)"

section "Worker"
psqlq "SELECT 'heartbeat ' || worker_id || ' v' || coalesce(version,'?') || ' last ' || to_char(now() - last_beat_at, 'HH24:MI:SS') || ' ago' FROM worker_heartbeats ORDER BY last_beat_at DESC LIMIT 3"
psqlt "SELECT job,
          max(started_at) FILTER (WHERE status = 'SUCCEEDED') AS last_success,
          count(*) FILTER (WHERE status = 'FAILED' AND started_at > now() - interval '24 hours') AS failed_24h,
          count(*) FILTER (WHERE started_at > now() - interval '24 hours') AS runs_24h,
          round(avg(duration_ms) FILTER (WHERE started_at > now() - interval '24 hours')) AS avg_ms_24h
        FROM worker_job_runs GROUP BY job ORDER BY job"

section "Backups"
systemctl list-timers ozzo-backup.timer --all 2>&1 | sed -n '1,2p'
echo "last run: $(systemctl show ozzo-backup.service -p ExecMainExitTimestamp -p ExecMainStatus -p Result 2>/dev/null | paste -sd' ')"
journalctl -u ozzo-backup.service --since '-3 days' --no-pager -o cat 2>/dev/null | grep -E 'backup ok|error|ERROR|fail' | tail -5
sets="$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' 2>/dev/null | sort)"
latest="$(printf '%s\n' "$sets" | tail -1)"
echo "sets: $(printf '%s\n' "$sets" | grep -c .), latest: ${latest:-none}"
if [ -n "$latest" ]; then
  find "$latest" -maxdepth 1 -type f -printf '  %f  %s bytes  %TY-%Tm-%Td %TH:%TM\n'
  (cd "$latest" && sha256sum --quiet -c SHA256SUMS && echo "checksums OK") || echo "CHECKSUM MISMATCH in $latest"
  "$PG_BIN/pg_restore" --list "$latest/ozzo.dump" >/dev/null 2>&1 && echo "dump readable (pg_restore --list)" || echo "DUMP NOT READABLE"
  cat "$latest/MANIFEST" 2>/dev/null
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$latest") ) / 3600 )); echo "latest set age: ${age_h} h"
fi
echo "offsite: configure and verify separately (OFFSITE BACKUP REQUIRED FOR PRODUCTION)"

section "Disk"
df -h / | tail -1
pgdata="$(psqlq 'SHOW data_directory' 2>/dev/null | tr -d ' ')"
for p in "$pgdata" "$DATA_ROOT/uploads" "$BACKUP_DIR" "$DATA_ROOT/www" "$LOG_DIR" "$APP_DIR"; do
  [ -n "$p" ] && [ -e "$p" ] && du -sh "$p" 2>/dev/null
done
du -ch "$NGINX_LOGS"/ozzo-* 2>/dev/null | tail -1 | sed 's/total/nginx ozzo logs/'
echo "uploads files: $(find "$DATA_ROOT/uploads" -type f 2>/dev/null | wc -l)"

section "Database"
psqlq "SELECT 'size ' || pg_size_pretty(pg_database_size(current_database()))"
psqlq "SELECT 'connections ' || count(*) || ' (active ' || count(*) FILTER (WHERE state = 'active') || ', idle in tx ' || count(*) FILTER (WHERE state LIKE 'idle in transaction%') || ') of max ' || current_setting('max_connections') FROM pg_stat_activity WHERE datname = current_database()"
psqlq "SELECT 'long running (>30s): ' || count(*) FROM pg_stat_activity WHERE datname = current_database() AND state <> 'idle' AND now() - query_start > interval '30 seconds'"
psqlq "SELECT 'waiting on locks: ' || count(*) FROM pg_locks WHERE NOT granted"
psqlq "SELECT 'deadlocks total: ' || deadlocks || ', cache hit ' || round(100.0 * blks_hit / greatest(blks_hit + blks_read, 1), 1) || '%' FROM pg_stat_database WHERE datname = current_database()"
psqlt "SELECT relname AS table, n_live_tup AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size,
          seq_scan, idx_scan FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 8"
psqlt "SELECT 'helmets' AS what, count(*) FROM helmets UNION ALL
        SELECT 'activated', count(*) FROM helmets WHERE activated_at IS NOT NULL UNION ALL
        SELECT 'customers', count(*) FROM users UNION ALL
        SELECT 'scans (detail)', count(*) FROM helmet_scans UNION ALL
        SELECT 'audit events', count(*) FROM audit_logs"

section "Redis"
redisq ping
redisq info memory | grep -E '^(used_memory_human|used_memory_peak_human|maxmemory_human|maxmemory_policy):'
redisq info stats | grep -E '^(evicted_keys|rejected_connections|expired_keys|keyspace_hits|keyspace_misses):'
redisq info clients | grep -E '^connected_clients:'
echo "keys: $(redisq dbsize)"
# --raw prints "min max avg samples" when interrupted (SIGINT) after 2 s.
lat="$(LATENCY_TIMEOUT=2 redisq --latency --raw 2>/dev/null | tail -1)"
echo "latency ms (min max avg samples, 2 s): ${lat:-n/a}"

section "Logs (last 24 h)"
since="$(date -u -d '-24 hours' +%Y-%m-%dT%H:%M)"
for f in "$LOG_DIR"/api.out.log "$LOG_DIR"/api.err.log "$LOG_DIR"/worker.out.log "$LOG_DIR"/worker.err.log; do
  [ -r "$f" ] || continue
  # pino levels: 40 warn, 50 error, 60 fatal. Counts only; no log lines are printed.
  printf '%-32s warn %s · error %s\n' "$(basename "$f")" \
    "$(awk -v s="$since" '$0 >= s' "$f" 2>/dev/null | grep -c '"level":40')" \
    "$(awk -v s="$since" '$0 >= s' "$f" 2>/dev/null | grep -cE '"level":(50|60)')"
done
for f in "$NGINX_LOGS"/ozzo-*.log; do
  [ -r "$f" ] || continue
  printf '%-32s 5xx %s · 429 %s · 4xx %s · total %s\n' "$(basename "$f")" \
    "$(grep -c '"status":"5' "$f")" "$(grep -c '"status":"429"' "$f")" \
    "$(grep -c '"status":"4' "$f")" "$(wc -l < "$f")"
done
echo "most frequent API error messages (no request data):"
grep -hE '"level":(50|60)' "$LOG_DIR"/api.*.log "$LOG_DIR"/worker.*.log 2>/dev/null | grep -o '"msg":"[^"]\{0,90\}' | sort | uniq -c | sort -rn | head -5

section "Host"
uptime
free -h | head -2
nproc
ps -eo pid,user,%cpu,%mem,rss,comm --sort=-rss | head -8
