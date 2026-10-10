# PM2 deployment on a shared aaPanel VPS (no Docker)

The production layout for **Ozzo Helmets**. The VPS is shared with other projects and runs
aaPanel, whose nginx owns ports 80/443. Docker is **not** used. Everything here adds new,
`ozzo`-prefixed resources and never modifies other sites, PM2 processes, MariaDB, Apache or
LiteSpeed. The Docker setup ([VPS-DEPLOYMENT](VPS-DEPLOYMENT.md)) stays the reference for a
dedicated server.

> **Single VPS, local backups only.** No high availability, and backups are not disaster-safe
> until they are copied offsite. See [Backups](#backups).

## Architecture

```
Internet ─► Cloudflare (proxied, SSL Full (strict)) ─► aaPanel nginx :443
   ├─ ozzohelmets.cloud        static portal build + /e/ + /verify/   /api → 127.0.0.1:4100
   ├─ admin.ozzohelmets.cloud  static admin build                     /api → 127.0.0.1:4100
   └─ api.ozzohelmets.cloud    → 127.0.0.1:4100
PM2 (user "ozzo", own daemon, systemd unit pm2-ozzo)
   ├─ ozzo-api     node --env-file=/etc/helmet-platform/app.env dist/main.js  (127.0.0.1:4100)
   └─ ozzo-worker  node --env-file=/etc/helmet-platform/app.env dist/worker.js
aaPanel PostgreSQL 17  127.0.0.1:5432  database/role "ozzo"
Redis 7 (apt)          127.0.0.1:6380  requirepass, noeviction, FLUSHALL/CONFIG disabled
```

| Path                                             | Contents                                                    | Owner / mode    |
| ------------------------------------------------ | ----------------------------------------------------------- | --------------- |
| `/opt/ozzohelmets`                               | git checkout (branch `claude/epic-gates-7picyo`)            | `ozzo` 755      |
| `/etc/helmet-platform/app.env`                   | all secrets and settings                                    | `root:ozzo` 640 |
| `/etc/helmet-platform/tls/origin.{crt,key}`      | Cloudflare Origin CA certificate                            | `root` 600      |
| `/etc/helmet-platform/nginx-cloudflare/`         | Cloudflare ranges (`realip.conf`)                           | `root` 644      |
| `/srv/helmet-platform/uploads`                   | profile photos, warranty proofs (local filesystem)          | `ozzo` 700      |
| `/srv/helmet-platform/www/{portal,admin}`        | symlinks to the current SPA release                         | `ozzo`          |
| `/srv/helmet-platform/backups`                   | local backup sets                                           | `ozzo` 700      |
| `/var/log/ozzohelmets/`                          | PM2 logs (api/worker)                                       | `ozzo`          |
| `/www/server/panel/vhost/nginx/0.ozzo-http.conf` | http-level maps/zones/upstream (`deploy/aapanel/http.conf`) | root            |
| `/www/server/panel/vhost/nginx/ozzo-*.conf`      | the three vhosts (`deploy/aapanel/ozzo-*.conf`)             | root            |
| `/etc/redis/redis-ozzo.conf`                     | Redis overrides (password)                                  | `redis` 640     |

The vhost files are written directly, not created through the aaPanel UI, so they don't show up
as aaPanel "sites". Don't create aaPanel sites with the same domain names: they would conflict.

## Edge behaviour (ported from the Docker edge)

- Real client IP: `CF-Connecting-IP` is honoured **only** when the TCP peer is a Cloudflare
  range (`set_real_ip_from`). `X-Forwarded-For` is **overwritten** with that IP and
  `CF-Connecting-IP` is stripped before the API. The API trusts only loopback
  (`TRUST_PROXY=loopback`, `TRUST_CLOUDFLARE=false`).
- HSTS plus the same per-surface CSPs as the SPA containers. `/e/` and `/verify/` get the
  strict emergency CSP, `noindex` and `no-cache`.
- `/api/v1/internal/` returns 404 on every host.
- Coarse `limit_req` per verified IP (generous bursts; the emergency pages are never
  login-throttled). The API enforces the fine-grained limits.
- JSON access logs **without client IPs**, with QR tokens masked (`/www/wwwlogs/ozzo-*.log`).
- aaPanel's global `proxy.conf` turns on `proxy_cache` and retries on 404/500/503. The Ozzo
  proxy snippet turns both off.

Refresh the Cloudflare ranges monthly (root):
`/opt/ozzohelmets/scripts/update-cloudflare-ips-aapanel.sh` (runs `nginx -t` before the reload).

## One-time server setup (already done on the production VPS)

1. User `ozzo` (password locked), plus the directories above.
2. `apt install redis-server`. Override file `/etc/redis/redis-ozzo.conf`, included at the end of
   `redis.conf`. aaPanel ships `/usr/local/lib/libjemalloc.so.2`, which the hardened Ubuntu unit
   (`NoExecPaths=/`) can't map, so the drop-in
   `/etc/systemd/system/redis-server.service.d/ozzo-jemalloc.conf` sets
   `LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu` for Redis only.
3. PostgreSQL: `ALTER ROLE ozzo PASSWORD '<generated>'` and `ALTER DATABASE ozzo OWNER TO ozzo`
   (needed to create the schema and the trusted `pg_trgm` extension). No `listen_addresses` or
   `pg_hba` changes, because the app connects over 127.0.0.1.
4. `/etc/helmet-platform/app.env` with freshly generated secrets, one per purpose. Keys:
   [deploy/env/app.env.example](../deploy/env/app.env.example), plus `API_HOST=127.0.0.1`,
   `API_PORT=4100`, `TRUST_PROXY=loopback`,
   `FILE_STORAGE_LOCAL_DIR=/srv/helmet-platform/uploads`.
5. Node: the existing system `/usr/bin/node` (v24), with pnpm run through
   `npx pnpm@10.28.0`. Nothing is installed globally.
6. PM2 for user `ozzo`: `pm2 startup systemd -u ozzo --hp /home/ozzo` (unit `pm2-ozzo`) and
   `pm2 save`.
7. nginx: copy `deploy/aapanel/http.conf` to `0.ozzo-http.conf` and `deploy/aapanel/ozzo-*.conf`
   to the vhost directory, then run `nginx -t` and `nginx -s reload`.
8. Backups: `deploy/pm2/ozzo-backup.{service,timer}` go into `/etc/systemd/system/`, then
   `systemctl enable --now ozzo-backup.timer`. `deploy/pm2/logrotate.conf` goes to
   `/etc/logrotate.d/ozzohelmets`.

> **Before every reload:** `/www/server/nginx/sbin/nginx -t`. Use reload (`-s reload`), never
> restart. Other sites share this nginx.

## Deploying

```bash
sudo -iu ozzo /opt/ozzohelmets/scripts/pm2-deploy.sh          # backup → build → migrate → reload
sudo -iu ozzo /opt/ozzohelmets/scripts/pm2-deploy.sh --skip-backup   # first deploy only
```

The script pulls the branch (fast-forward only), runs `pnpm install --frozen-lockfile` and builds
types/api/admin/portal. It then runs `prisma migrate deploy`, publishes the SPAs (atomic symlink
swap, keeping the last 3 releases), runs `pm2 startOrReload` and waits for
`/api/v1/health/ready`. Finally it checks that both processes are `online` and runs `pm2 save`.
It never runs `migrate reset` or `db push`.

**Rollback (code only):**
`sudo -iu ozzo bash -c 'cd /opt/ozzohelmets && git checkout <previous-sha> && scripts/pm2-deploy.sh --no-pull'`.
Migrations are forward-only and backward compatible for one release, so the database stays as
it is. Previous SPA builds remain in `/srv/helmet-platform/www/releases/`.

### Day-to-day

```bash
sudo -iu ozzo pm2 ls                         # only ozzo-api / ozzo-worker (own daemon)
sudo -iu ozzo pm2 logs ozzo-api --lines 200
curl -s http://127.0.0.1:4100/api/v1/health/ready
```

Never run `pm2` as root for this app. That starts a separate root daemon, and the `www` user's
PM2 belongs to another project.

### Admin bootstrap (no default credentials)

```bash
sudo -iu ozzo
cd /opt/ozzohelmets/apps/api
read -rs PW   # 12+ chars, upper/lower/digit; not echoed
printf '%s' "$PW" | node --env-file=/etc/helmet-platform/app.env dist/cli.js admin:bootstrap \
  --email ops@example.com --name "Ops Lead"
unset PW
```

It refuses to run if a SUPER_ADMIN already exists.

## Backups

`scripts/pg-backup.sh` (daily via `ozzo-backup.timer`; run by hand with
`sudo -u ozzo /opt/ozzohelmets/scripts/pg-backup.sh`) writes
`/srv/helmet-platform/backups/<UTC timestamp>/` containing `ozzo.dump` (pg_dump custom format),
`uploads.tar.gz`, `SHA256SUMS` and a `MANIFEST`. Sets are kept for 14 days.

- **OFFSITE BACKUP REQUIRED FOR PRODUCTION.** Copy the backup directory off the server, for
  example with rclone/rsync to another provider.
- Back up `/etc/helmet-platform/app.env` (especially `DATA_ENCRYPTION_KEYS` and
  `PIN_ESCROW_KEYS`) **separately and offline**, with two people able to access it. Without the
  keyring a dump can't restore medical fields.

### Restore

Restore drills go into a **scratch database**, never into `ozzo`:

```bash
cd /tmp && sudo -u postgres /www/server/pgsql/bin/createdb -O ozzo ozzo_restore_drill
sudo -u postgres /www/server/pgsql/bin/pg_restore --no-owner --role=ozzo \
  -d ozzo_restore_drill /srv/helmet-platform/backups/<set>/ozzo.dump
# ...verify row counts, then:
sudo -u postgres /www/server/pgsql/bin/dropdb ozzo_restore_drill
```

Restoring over the production database requires explicit confirmation: stop
`ozzo-api`/`ozzo-worker` first and take a fresh backup.

## Known shared-host caveats

- aaPanel's `pg_hba.conf` has `host all all 127.0.0.1/32 trust` above the `ozzo` md5 line, so any
  local process can connect to any database without a password. This is shared aaPanel
  configuration and is left unchanged until the server owner decides.
- UFW allows 5432/tcp+udp from anywhere. PostgreSQL listens on localhost only, but the rule
  should be removed.
- 2 vCPU and no swap: builds and Argon2 compete with the other projects. Keep
  `ARGON2_MAX_CONCURRENCY=1`.
