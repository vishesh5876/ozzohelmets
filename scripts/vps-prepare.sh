#!/usr/bin/env bash
# One-time (idempotent) host preparation for the Helmet Platform on Ubuntu 24.04 / Debian 12.
# Run with sudo AFTER installing Docker (docs/VPS-DEPLOYMENT.md §2). It never touches existing
# data; it only creates missing directories, the deployment user and file permissions.
#
#   sudo scripts/vps-prepare.sh [deploy-user]
set -Eeuo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }

DEPLOY_USER="${1:-helmetdeploy}"
DATA_ROOT="${DATA_ROOT:-/srv/helmet-platform}"
CONFIG_DIR="${CONFIG_DIR:-/etc/helmet-platform}"
APP_DIR="${APP_DIR:-/opt/helmet-platform}"
APP_UID=1000      # "node" user inside the API image (owns uploads)
PG_UID=70         # "postgres" user inside postgres:16-alpine
REDIS_UID=999     # "redis" user inside redis:7-alpine
CLAMAV_UID=100    # "clamav" user inside clamav/clamav
PROM_UID=65534    # "nobody" inside prom/* images

id "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"
getent group docker >/dev/null && usermod -aG docker "$DEPLOY_USER"

install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 750 -o root -g "$DEPLOY_USER" "$CONFIG_DIR" "$CONFIG_DIR/tls" "$CONFIG_DIR/monitoring"
install -d -m 755 -o root -g root "$DATA_ROOT"
install -d -m 700 -o "$PG_UID" -g "$PG_UID" "$DATA_ROOT/postgres"
install -d -m 700 -o "$REDIS_UID" -g "$REDIS_UID" "$DATA_ROOT/redis"
# Uploads: writable only by the API container user — never chmod 777.
install -d -m 700 -o "$APP_UID" -g "$APP_UID" "$DATA_ROOT/uploads"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DATA_ROOT/backups" "$DATA_ROOT/deploy-state"
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DATA_ROOT/node-exporter-textfile" "$DATA_ROOT/acme"
install -d -m 755 -o "$CLAMAV_UID" -g "$CLAMAV_UID" "$DATA_ROOT/clamav"
install -d -m 755 -o "$PROM_UID" -g "$PROM_UID" "$DATA_ROOT/prometheus" "$DATA_ROOT/alertmanager"

# Secrets: readable by root and the deployment group only.
for f in app.env postgres.env compose.env backup.env monitoring.env; do
  [ -f "$CONFIG_DIR/$f" ] && chown root:"$DEPLOY_USER" "$CONFIG_DIR/$f" && chmod 640 "$CONFIG_DIR/$f"
done
[ -f "$CONFIG_DIR/tls/origin.key" ] && chown root:"$DEPLOY_USER" "$CONFIG_DIR/tls/origin.key" && chmod 640 "$CONFIG_DIR/tls/origin.key"

echo "Prepared:"
echo "  app checkout   $APP_DIR (owner $DEPLOY_USER)"
echo "  configuration  $CONFIG_DIR (root:$DEPLOY_USER, 750; env files 640)"
echo "  data           $DATA_ROOT/{postgres,redis,uploads,backups,...}"
echo "Next: docs/VPS-DEPLOYMENT.md §5 (env files) and §7 (first deploy)."
