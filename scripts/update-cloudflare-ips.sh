#!/usr/bin/env bash
# Refreshes the Cloudflare edge ranges used by the edge proxy (real client IP + optional origin
# lock) and reloads nginx. Run monthly (or from cron); safe to re-run.
#
#   scripts/update-cloudflare-ips.sh           # writes ${CLOUDFLARE_IPS_DIR:-/etc/helmet-platform/nginx-cloudflare}
# Then set CLOUDFLARE_IPS_DIR in /etc/helmet-platform/compose.env to that directory.
set -Eeuo pipefail
OUT="${CLOUDFLARE_IPS_DIR:-/etc/helmet-platform/nginx-cloudflare}"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-/etc/helmet-platform/compose.env}"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsS --max-time 20 https://www.cloudflare.com/ips-v4 -o "$tmp/v4"
curl -fsS --max-time 20 https://www.cloudflare.com/ips-v6 -o "$tmp/v6"
valid() { grep -Eq '^[0-9a-fA-F:.]+/[0-9]+$' "$1" && [ "$(wc -l < "$1")" -ge 5 ]; }
if ! valid "$tmp/v4" || ! valid "$tmp/v6"; then
  echo "unexpected response from cloudflare.com; keeping current ranges" >&2
  exit 1
fi
mkdir -p "$OUT"
{
  echo "# Cloudflare edge ranges — generated $(date -u +%FT%TZ) by update-cloudflare-ips.sh"
  while read -r r; do [ -n "$r" ] && echo "set_real_ip_from $r;"; done < <(cat "$tmp/v4" "$tmp/v6")
  echo "real_ip_header CF-Connecting-IP;"
  echo "real_ip_recursive off;"
} > "$tmp/realip.conf"
{
  echo "# Cloudflare edge ranges — generated $(date -u +%FT%TZ)"
  echo "geo \$realip_remote_addr \$from_cloudflare {"
  echo "  default 0;"
  echo "  127.0.0.1 1;"
  while read -r r; do [ -n "$r" ] && echo "  $r 1;"; done < <(cat "$tmp/v4" "$tmp/v6")
  echo "}"
} > "$tmp/geo.conf"
install -m 644 "$tmp/realip.conf" "$OUT/realip.conf"
install -m 644 "$tmp/geo.conf" "$OUT/geo.conf"
if docker compose -f "$COMPOSE_DIR/docker-compose.prod.yml" --env-file "$COMPOSE_ENV_FILE" ps -q edge >/dev/null 2>&1; then
  docker compose -f "$COMPOSE_DIR/docker-compose.prod.yml" --env-file "$COMPOSE_ENV_FILE" exec -T edge nginx -t
  docker compose -f "$COMPOSE_DIR/docker-compose.prod.yml" --env-file "$COMPOSE_ENV_FILE" exec -T edge nginx -s reload
fi
echo "Cloudflare ranges updated in $OUT"
