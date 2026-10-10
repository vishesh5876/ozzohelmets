#!/usr/bin/env bash
# Ozzo Helmets: build + deploy on the shared aaPanel VPS with PM2 (no Docker).
# Run as the "ozzo" user from the checkout:
#
#   sudo -iu ozzo /opt/ozzohelmets/scripts/pm2-deploy.sh                 # pull branch, backup, deploy
#   sudo -iu ozzo /opt/ozzohelmets/scripts/pm2-deploy.sh --skip-backup   # first deploy
#   sudo -iu ozzo /opt/ozzohelmets/scripts/pm2-deploy.sh --no-pull       # deploy the current checkout
#
# Steps: git pull (ff-only) → backup → pnpm install → build api/admin/portal → prisma migrate deploy
# → publish SPAs (atomic symlink swap) → pm2 startOrReload → health checks → pm2 save.
# Never runs `migrate reset` / `db push`, never deletes data. See docs/PM2-DEPLOYMENT.md.
set -Eeuo pipefail

APP_DIR="${OZZO_APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="${OZZO_ENV_FILE:-/etc/helmet-platform/app.env}"
WWW_DIR="${OZZO_WWW_DIR:-/srv/helmet-platform/www}"
BRANCH="${OZZO_BRANCH:-claude/epic-gates-7picyo}"
PNPM_VERSION="10.28.0"
KEEP_RELEASES=3
SKIP_BACKUP=0
PULL=1

for arg in "$@"; do
  case "$arg" in
    --skip-backup) SKIP_BACKUP=1 ;;
    --no-pull) PULL=0 ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -un)" = "ozzo" ] || die "run as the ozzo user (sudo -iu ozzo $0)"
[ -r "$ENV_FILE" ] || die "$ENV_FILE not readable"
command -v pm2 >/dev/null || die "pm2 not found"
cd "$APP_DIR"

# aaPanel's global npmrc points the npm cache at a shared root-owned directory: use our own.
export npm_config_cache="${HOME}/.npm" npm_config_update_notifier=false
pnpm() { CI=true npx -y "pnpm@${PNPM_VERSION}" "$@"; }

if [ "$PULL" = 1 ]; then
  log "git pull ($BRANCH)"
  git fetch --quiet origin "$BRANCH"
  git checkout --quiet "$BRANCH"
  git merge --ff-only --quiet "origin/$BRANCH"
fi
GIT_SHA="$(git rev-parse HEAD)"
APP_VERSION="$(git describe --tags --always 2>/dev/null || echo "${GIT_SHA:0:12}")"
BUILD_DATE="$(date -u +%FT%TZ)"
STAMP="$(date -u +%Y%m%d%H%M%S)-${GIT_SHA:0:7}"
export GIT_SHA APP_VERSION BUILD_DATE

if [ "$SKIP_BACKUP" = 0 ]; then
  log "backup"
  "$APP_DIR/scripts/pg-backup.sh"
fi

log "install dependencies"
pnpm install --frozen-lockfile

log "build api"
pnpm --filter @helmet/types build
pnpm --filter @helmet/api exec prisma generate
pnpm --filter @helmet/api exec nest build -p tsconfig.build.json

log "build admin + portal"
for app in admin portal; do
  VITE_APP_VERSION="$APP_VERSION" VITE_GIT_SHA="$GIT_SHA" \
    VITE_EMERGENCY_NUMBER="${EMERGENCY_NUMBER:-112}" \
    pnpm --filter "@helmet/$app" exec vite build
done

log "prisma migrate deploy"
# Only DATABASE_URL is exported (never `source` the env file: values contain '&').
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE")" \
  pnpm --filter @helmet/api exec prisma migrate deploy

log "publish SPAs"
mkdir -p "$WWW_DIR/releases"
for app in admin portal; do
  dest="$WWW_DIR/releases/$app-$STAMP"
  cp -a "apps/$app/dist" "$dest"
  ln -sfn "$dest" "$WWW_DIR/.$app.tmp"
  mv -Tf "$WWW_DIR/.$app.tmp" "$WWW_DIR/$app"   # atomic swap
  # Keep the newest releases only.
  ls -1dt "$WWW_DIR/releases/$app-"* | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf
done

log "pm2 startOrReload"
pm2 startOrReload deploy/pm2/ecosystem.config.cjs --update-env

log "health checks"
port="$(sed -n 's/^API_PORT=//p' "$ENV_FILE")"; port="${port:-4100}"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${port}/api/v1/health/ready" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || { pm2 logs ozzo-api --lines 60 --nostream || true; die "API not ready on :$port"; }
curl -fsS "http://127.0.0.1:${port}/api/v1/health/ready"; echo
sleep 5
for name in ozzo-api ozzo-worker; do
  status="$(pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s).find(x=>x.name==='$name');console.log(p?p.pm2_env.status:'missing')})")"
  echo "$name: $status"
  [ "$status" = online ] || die "$name is $status"
done

pm2 save --force >/dev/null
log "deployed $APP_VERSION ($GIT_SHA)"
