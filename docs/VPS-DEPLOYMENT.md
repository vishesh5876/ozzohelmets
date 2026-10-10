# VPS deployment

Exact steps to run the Helmet Platform on **one Linux VPS** behind **Cloudflare**, with
everything in **Docker Compose** and uploads on the **local VPS filesystem**. No AWS, no S3, no
Node.js on the host. Related: [DISASTER-RECOVERY](DISASTER-RECOVERY.md) ·
[INCIDENT-RESPONSE](INCIDENT-RESPONSE.md) · [MONITORING](MONITORING.md) ·
[LAUNCH-CHECKLIST](LAUNCH-CHECKLIST.md) · [WORKER](WORKER.md).

> **Single VPS = no high availability.** If the server or its provider fails, the platform is
> down until it is restored from backups (RTO: hours). Cloudflare does not hide an origin outage.

## 0. Architecture

```
Internet ─► Cloudflare (proxied DNS, Full (strict), WAF/DDoS) ─► VPS :443 (UFW: 22/80/443)
  edge  nginx  — TLS, real client IP, host routing, coarse limits, HSTS, access logs without IPs
   ├─ safe.example.com  ─► portal  (SPA + /e/<token> + /verify/<token>, proxies /api)
   ├─ admin.example.com ─► admin   (SPA, proxies /api)
   └─ api.example.com   ─► api:4000 (optional direct API host)
  api ─ worker ─ postgres ─ redis        (private "backend" network, no published ports)
  clamav (profile "clamav")   prometheus/alertmanager/exporters (profile "monitoring")
```

| Path on host                    | Contents                                      | Owner (UID)         | Mode |
| ------------------------------- | --------------------------------------------- | ------------------- | ---- |
| `/opt/helmet-platform`          | git checkout (compose file, scripts, configs) | `helmetdeploy`      | 755  |
| `/etc/helmet-platform/*.env`    | secrets and settings                          | `root:helmetdeploy` | 640  |
| `/etc/helmet-platform/tls/`     | origin certificate + key                      | `root:helmetdeploy` | 750  |
| `/srv/helmet-platform/postgres` | PostgreSQL data                               | 70 (postgres)       | 700  |
| `/srv/helmet-platform/redis`    | Redis AOF                                     | 999 (redis)         | 700  |
| `/srv/helmet-platform/uploads`  | profile photos, warranty proofs               | 1000 (API user)     | 700  |
| `/srv/helmet-platform/backups`  | local backup sets                             | `helmetdeploy`      | 700  |

Mutable data never lives inside the git checkout or a container layer.

## 1. Server sizing

| Profile                          | vCPU | RAM  | Disk           | Notes                                                  |
| -------------------------------- | ---- | ---- | -------------- | ------------------------------------------------------ |
| Testing / pilot                  | 2    | 4 GB | 60 GB SSD      | without ClamAV and the monitoring profile              |
| Initial production (recommended) | 4    | 8 GB | 100–160 GB SSD | room for ClamAV (~1.2 GB), Prometheus, backups, growth |

Capacity measurements: [PHASE-7 → load test](PHASE-7.md#load-test). Add swap (2–4 GB) as an
OOM cushion; alerts fire if it is used heavily.

## 2. Prepare Ubuntu 24.04 LTS

```bash
# as root on a fresh server
apt-get update && apt-get -y full-upgrade
apt-get -y install ca-certificates curl git ufw fail2ban unattended-upgrades zstd jq
dpkg-reconfigure -plow unattended-upgrades            # automatic security updates

# Docker Engine + Compose v2 (official repository)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release; echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Docker daemon defaults (`/etc/docker/daemon.json`) — bounded logs for anything outside Compose:

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true
}
```

`systemctl restart docker`.

### Deployment user and SSH hardening

```bash
git clone https://github.com/<org>/<repo>.git /opt/helmet-platform
/opt/helmet-platform/scripts/vps-prepare.sh helmetdeploy     # user, directories, ownership (idempotent)
mkdir -p /home/helmetdeploy/.ssh && cp ~/.ssh/authorized_keys /home/helmetdeploy/.ssh/
chown -R helmetdeploy: /home/helmetdeploy/.ssh && chmod 700 /home/helmetdeploy/.ssh
```

Only after confirming key login as `helmetdeploy` (and an admin user with sudo) works in a
**second session**, set in `/etc/ssh/sshd_config.d/50-hardening.conf`:

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
```

`systemctl reload ssh`. `helmetdeploy` is in the `docker` group (root-equivalent for Docker —
protect its key) and needs no sudo for deployments. Fail2ban's default `sshd` jail is enough.

### Firewall (UFW)

```bash
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp          # or your SSH port — SSH is never routed through Cloudflare
ufw allow 80/tcp && ufw allow 443/tcp
ufw enable
```

Never open 4000, 5432 or 6379: the compose file publishes only 80/443. Docker publishes ports
through its own iptables chains, which bypass UFW — that is why nothing else is published at all.

**Origin protection options** (trade-offs):

| Option                                                    | Effect                                                  | Trade-off                                                        |
| --------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| UFW 22/80/443 (minimum, default)                          | only web + SSH reachable                                | the origin IP can still be hit directly (bypassing the WAF)      |
| `ORIGIN_ACCESS=cloudflare-only` in compose.env            | edge closes connections whose TCP peer isn't Cloudflare | keep the ranges fresh (`scripts/update-cloudflare-ips.sh`)       |
| Cloud-provider firewall allowing 443 only from Cloudflare | strongest (packets dropped before the VPS)              | manual range updates; check provider support                     |
| Cloudflare Authenticated Origin Pulls (mTLS)              | origin accepts only Cloudflare's client certificate     | extra nginx config (`ssl_verify_client`); not enabled by default |

Recommended at launch: UFW + `cloudflare-only` + monthly range refresh.

## 3. Cloudflare

1. DNS: `A` records for `safe`, `admin`, `api` → VPS IPv4 (and `AAAA` if IPv6), **Proxied**.
2. SSL/TLS → **Full (strict)**. Edge Certificates: Always Use HTTPS, minimum TLS 1.2, HSTS may be
   enabled once everything works (the origin already sends `max-age=31536000; includeSubDomains`).
3. Origin certificate: SSL/TLS → Origin Server → Create certificate (RSA, the three hostnames,
   15 years). Save as `/etc/helmet-platform/tls/origin.crt` and `origin.key` (640,
   root:helmetdeploy). Alternative: Let's Encrypt via DNS-01 (`certbot --dns-cloudflare`) writing
   to the same paths, then `docker compose … exec edge nginx -s reload` after renewal.
4. Caching: leave the default (static assets only). Do **not** cache `/api/*` or HTML; API
   responses are `no-store`. `/e/*` is `no-cache`.
5. Security: WAF managed rules on; Bot Fight Mode is optional — test that `/e/<token>` still loads
   from phones on mobile data before enabling any challenge (never put a challenge on `/e/`).

**Client IP**: the edge honours `CF-Connecting-IP` **only** when the TCP peer is a Cloudflare
address (`set_real_ip_from` list), then overwrites `X-Forwarded-For` with that verified IP. The API
trusts only the private edge subnet (`TRUST_PROXY=172.30.0.0/24`, `TRUST_CLOUDFLARE=false`), so a
client-supplied `X-Forwarded-For` or `CF-Connecting-IP` can never set its own IP.

## 4. TLS

Origin certificates from Cloudflare are only trusted by Cloudflare — correct for Full (strict).
Visitors always see Cloudflare's edge certificate. The `default_server` on 443 returns 444 for
unknown hostnames, so the origin doesn't serve the site on its bare IP.

## 5. Configuration and secrets

```bash
cd /opt/helmet-platform
sudo install -m 640 -o root -g helmetdeploy deploy/env/app.env.example      /etc/helmet-platform/app.env
sudo install -m 640 -o root -g helmetdeploy deploy/env/postgres.env.example /etc/helmet-platform/postgres.env
sudo install -m 640 -o root -g helmetdeploy deploy/env/compose.env.example  /etc/helmet-platform/compose.env
sudo install -m 640 -o root -g helmetdeploy deploy/env/backup.env.example   /etc/helmet-platform/backup.env
```

Generate **every** secret separately — the application refuses to start with reused or dev
secrets, weak database passwords, wildcard/HTTP CORS, a non-HTTPS QR URL or Swagger enabled:

```bash
openssl rand -base64 48 | tr -d '\n=/+'   # each of: JWT_ACCESS_SECRET, JWT_CUSTOMER_ACCESS_SECRET,
                                          # CUSTOMER_CREDENTIAL_PEPPER, PIN_HASH_PEPPER, IP_HASH_SECRET,
                                          # METRICS_TOKEN, the database password
openssl rand -base64 32                   # DATA_ENCRYPTION_KEYS=v1:<this>, PIN_ESCROW_KEYS=v1:<another>
```

### Secret inventory

| Secret                               | Used for                                                                   | Rotation impact                                                               |
| ------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` / `DATABASE_URL` | DB access (same value in both files)                                       | change in both, restart postgres + api + worker                               |
| `JWT_ACCESS_SECRET`                  | admin access tokens (15 min)                                               | admins re-login                                                               |
| `JWT_CUSTOMER_ACCESS_SECRET`         | customer access tokens (15 min)                                            | customers silently refresh (refresh tokens are DB-hashed)                     |
| `CUSTOMER_CREDENTIAL_PEPPER`         | Argon2id pepper for customer passwords + recovery codes                    | **never rotate casually** — invalidates every customer password/recovery code |
| `PIN_HASH_PEPPER`                    | Argon2id pepper for activation PINs + transfer codes                       | invalidates unused PINs on printed labels — do not rotate after printing      |
| `IP_HASH_SECRET`                     | HMAC of client IPs (rate limits, analytics)                                | analytics visitor continuity resets; harmless                                 |
| `DATA_ENCRYPTION_KEYS`               | AES-256-GCM keyring for medical fields                                     | see key rotation below; **loss = medical data unrecoverable**                 |
| `PIN_ESCROW_KEYS`                    | AES-256-GCM keyring for the short-lived PIN escrow                         | see key rotation; escrow is purged when a batch is printed                    |
| `METRICS_TOKEN`                      | Prometheus scrape of `/api/v1/internal/metrics`                            | update `monitoring/metrics_token` too                                         |
| TLS origin key                       | edge TLS                                                                   | reissue in Cloudflare                                                         |
| Redis                                | no password: reachable only on the internal network with no published port | add `requirepass` + `REDIS_URL` credentials if the host is shared             |

Refresh tokens, recovery-grant credentials, transfer codes and reset tickets are per-user values
stored hashed (DB) or short-lived (Redis) — not deployment secrets.

**Back up `/etc/helmet-platform` (especially both keyrings) separately and offline** — e.g. in a
password manager / sealed vault with two people able to access it. A database backup without
`DATA_ENCRYPTION_KEYS` cannot restore medical information.

### Encryption key rotation (offline, never on boot)

```bash
# 1. Prepend a new key version, keep the old one: DATA_ENCRYPTION_KEYS=v2:<new>,v1:<old>
# 2. Deploy (new writes use v2; v1 still decrypts)
docker compose -f docker-compose.prod.yml --env-file /etc/helmet-platform/compose.env \
  run --rm --no-deps api node dist/cli.js encryption:rotate --keyring data --dry-run
docker compose … run --rm --no-deps api node dist/cli.js encryption:rotate --keyring data
docker compose … run --rm --no-deps api node dist/cli.js encryption:status
# 3. Only when status shows no "v1" ciphertexts: remove v1 from the keyring and deploy.
```

Batched, restartable (re-run any time), idempotent, audited (`system.encryption_keys_rotated`,
counts only), never logs plaintext; concurrent owner edits win and are skipped. Same for
`--keyring escrow`.

## 6. PostgreSQL and Redis

PostgreSQL 16 runs in Docker on the private network only; data in
`/srv/helmet-platform/postgres`. TLS between containers is not used: traffic never leaves the
host's private bridge. Use SSL only if the database moves to another machine.

### PostgreSQL tuning

Values come from `compose.env` (`PG_*`). Start conservative and adjust to measured load:

| RAM   | `shared_buffers` | `effective_cache_size` | `work_mem` | `maintenance_work_mem` | `max_connections` |
| ----- | ---------------- | ---------------------- | ---------- | ---------------------- | ----------------- |
| 4 GB  | 512MB            | 1536MB                 | 8MB        | 128MB                  | 100               |
| 8 GB  | 1GB              | 4GB                    | 16MB       | 256MB                  | 100               |
| 16 GB | 2GB              | 10GB                   | 16MB       | 512MB                  | 150               |

Slow statements (> `PG_SLOW_QUERY_MS`, default 1 s) are logged **without bind parameters**
(`log_parameter_max_length=0`); lock waits are logged; idle transactions are cut after 60 s.

### Connection budget (no PgBouncer needed)

`DATABASE_URL` carries `connection_limit=10`. Worst case:

| Consumer                                   | Connections     |
| ------------------------------------------ | --------------- |
| API × `API_REPLICAS` (1–2) × 10            | 10–20           |
| worker (pool 10, + 1 job-lock transaction) | ≤ 11            |
| migrations / CLI one-off                   | ≤ 10            |
| backup (`pg_dump`) + `psql`                | 2               |
| postgres-exporter                          | 1–2             |
| **Total**                                  | **≤ 45 of 100** |

### Redis

Ephemeral by design (rate limits, caches, detection windows, recent-auth, reset tickets). AOF
`everysec`, `maxmemory 256mb`, `noeviction` (security keys are never silently evicted — if Redis
fills up, writes fail, logins fail closed with 503, emergency pages keep working). `FLUSHALL` and
`CONFIG` are disabled. Behaviour when Redis is down: [PHASE-7 → failure tests](PHASE-7.md#failure-tests).

## 7. First deployment

```bash
sudo -iu helmetdeploy
cd /opt/helmet-platform
git checkout v1.0.0                                  # an approved tag
scripts/deploy-vps.sh --skip-backup                  # first run: nothing to back up yet
```

`deploy-vps.sh` checks files and permissions, validates the compose file, builds the images on
the VPS (or `--pull` prebuilt ones), starts PostgreSQL/Redis, runs
`prisma migrate deploy` as a one-off container, starts api → worker/admin/portal → edge, waits for
health checks and runs smoke checks through the edge. It never deletes volumes and never runs
`migrate reset` or `db push`.

### Admin bootstrap (no default credentials)

```bash
read -rs PW   # type a strong password (12+ chars, upper/lower/digit); not echoed, not in history
printf '%s' "$PW" | docker compose -f docker-compose.prod.yml --env-file /etc/helmet-platform/compose.env \
  run --rm -T --no-deps api node dist/cli.js admin:bootstrap --email ops@example.com --name "Ops Lead"
unset PW
```

It refuses if any SUPER_ADMIN exists, so it can't be reused as a backdoor. Create further admins
in the console (Admin users). There is no bootstrap secret to remove afterwards.

### Persistent uploads

`/srv/helmet-platform/uploads` (UID 1000, 0700) is bind-mounted at `/app/storage`; the API checks
at startup that it is writable and fails otherwise. Files are 0600, directories 0700. Profile
photos are served only through the API (privacy checked each time); warranty proofs only via an
authenticated, authorised download. Nginx never serves the uploads directory.

## 8. Backups

```bash
sudo cp deploy/systemd/helmet-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now helmet-backup.timer
systemctl list-timers helmet-backup.timer
sudo -u helmetdeploy scripts/backup.sh     # run one now
```

Details, retention, offsite copy and restore: [DISASTER-RECOVERY](DISASTER-RECOVERY.md).

## 9. Upgrades

1. Read the release notes (migrations?). 2. `scripts/deploy-vps.sh --ref vX.Y.Z` (takes a backup,
   builds, migrates, restarts, smoke-tests). 3. Watch the admin **System status** card and alerts.

With CI building images: push tags to a registry, set `IMAGE_PREFIX`, then
`scripts/deploy-vps.sh --pull` with `APP_VERSION=vX.Y.Z` in compose.env. Production deployment is
always a manual, approved step — CI never deploys.

Migrations are **forward-only** and must stay backward compatible for one release (add columns
nullable, backfill, then tighten later), so the previous image keeps working against the new schema.

## 10. Rollback

```bash
scripts/deploy-vps.sh --rollback v1.0.0     # restart on the previous images; no migration
```

Keep at least the previous release's images (`docker image prune --filter until=720h` removes only
older ones). Database problems are fixed **forward** (a new migration); a catastrophic data
problem uses the restore procedure. Never `prisma migrate reset` in production.

## 11. Optional components

- **ClamAV**: `docker compose … --profile clamav up -d clamav`, then `MALWARE_SCAN_ENABLED=true` in
  app.env and redeploy. Warranty PDFs are scanned in memory before being stored; when the scanner
  is unreachable uploads fail closed (503). Needs ~1.2 GB RAM. Recommended for public production.
- **Monitoring**: [MONITORING](MONITORING.md).
- **Two API replicas**: `API_REPLICAS=2` in compose.env and redeploy. The edge balances by Docker
  DNS (re-resolved every 10 s); all state is in PostgreSQL/Redis. Not needed initially.
- **Staging on the same VPS** (if resources allow): a second checkout with its own
  `COMPOSE_PROJECT_NAME=helmet-staging`, `DATA_ROOT`, env files, domains and `EDGE_SUBNET`, and
  different `HTTP_BIND`/`HTTPS_BIND` ports or a separate IP. Never share the production database.
  A separate small VPS is better.

## 12. Health endpoints

| URL                               | Meaning                                                              |
| --------------------------------- | -------------------------------------------------------------------- |
| `/api/v1/health/live`             | process answers (no dependency checks)                               |
| `/api/v1/health/ready`            | 200 `ok`; 200 `degraded` if Redis is down; 503 if PostgreSQL is down |
| `/api/v1/internal/metrics`        | Prometheus, bearer `METRICS_TOKEN`; **404 from the internet** (edge) |
| admin → Dashboard → System status | API version, worker heartbeat, last success of each job              |
