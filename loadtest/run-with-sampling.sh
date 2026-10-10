#!/usr/bin/env bash
# Runs one k6 scenario against a staging stack while sampling container CPU/memory, PostgreSQL
# connections and Redis memory every 5 s. Results go to loadtest/results/<scenario>.*
#   COMPOSE="docker compose -f docker-compose.prod.yml --env-file …" NETWORK=helmet-stage_edge \
#   ADMIN_EMAIL=… ADMIN_PASSWORD=… loadtest/run-with-sampling.sh emergency_cached [RATE] [DURATION]
set -Eeuo pipefail
SCENARIO=$1; RATE=${2:-}; DURATION=${3:-60s}
OUT="$(cd "$(dirname "$0")" && pwd)/results"; mkdir -p "$OUT"
PROJECT=${PROJECT:-helmet-stage}
: "${COMPOSE:?set COMPOSE to the docker compose command for the stack}"
sample() {
  while :; do
    ts=$(date -u +%T)
    docker stats --no-stream --format "{{.Name}} {{.CPUPerc}} {{.MemUsage}}" | grep "^$PROJECT-" | sed "s/^/$ts /" >> "$OUT/$SCENARIO.stats"
    pg=$($COMPOSE exec -T postgres psql -U helmet -d helmet_platform -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname = 'helmet_platform'" | tr -d '\r')
    rm=$($COMPOSE exec -T redis redis-cli info memory | grep '^used_memory:' | cut -d: -f2 | tr -d '\r')
    echo "$ts pg_connections=$pg redis_used_bytes=$rm" >> "$OUT/$SCENARIO.db"
    sleep 5
  done
}
: > "$OUT/$SCENARIO.stats"; : > "$OUT/$SCENARIO.db"
sample & SAMPLER=$!
trap 'kill $SAMPLER 2>/dev/null || true' EXIT
docker run --rm -i --network "${NETWORK:-helmet-stage_edge}" \
  -e SCENARIO="$SCENARIO" ${RATE:+-e RATE="$RATE"} -e DURATION="$DURATION" \
  -e BASE=http://portal:8080 -e ADMIN_BASE=http://admin:8080 \
  -e ADMIN_EMAIL="${ADMIN_EMAIL:-}" -e ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" \
  -v "$(cd "$(dirname "$0")" && pwd):/lt:ro" -v "$OUT:/out" grafana/k6:0.54.0 run --quiet \
  --summary-export "/out/$SCENARIO.summary.json" /lt/k6/scenarios.js \
  > "$OUT/$SCENARIO.k6.log" 2>&1 || echo "k6 exited non-zero (thresholds?) — see $OUT/$SCENARIO.k6.log"
kill $SAMPLER 2>/dev/null || true
# Peaks per container
awk '{gsub("%","",$3); n=$2; cpu=$3+0; if (cpu>c[n]) c[n]=cpu; m[n]=$4} END {for (k in c) printf "  %-28s peak CPU %6.1f%%  last mem %s\n", k, c[k], m[k]}' "$OUT/$SCENARIO.stats" | sort
awk -F'[ =]' '{if ($3>p) p=$3; if ($5>r) r=$5} END {printf "  peak pg_connections %d, peak redis used %.1f MB\n", p, r/1048576}' "$OUT/$SCENARIO.db"
