#!/usr/bin/env bash
# Refreshes the Cloudflare ranges used by the Ozzo aaPanel vhosts (real client IP) and reloads
# aaPanel nginx only if the configuration test passes. Run as root, monthly (cron) or on demand:
#
#   /opt/ozzohelmets/scripts/update-cloudflare-ips-aapanel.sh
set -Eeuo pipefail
NGINX="${NGINX_BIN:-/www/server/nginx/sbin/nginx}"
export CLOUDFLARE_IPS_DIR="${CLOUDFLARE_IPS_DIR:-/etc/helmet-platform/nginx-cloudflare}"
"$(dirname "$0")/update-cloudflare-ips.sh"
"$NGINX" -t
"$NGINX" -s reload
echo "cloudflare ranges refreshed in $CLOUDFLARE_IPS_DIR; nginx reloaded"
