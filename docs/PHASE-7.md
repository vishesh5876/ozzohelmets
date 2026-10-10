# Phase 7 — VPS Production Deployment, Monitoring, Backups, Launch Readiness

Target: **one Linux VPS** (Ubuntu 24.04 LTS) behind **Cloudflare**, everything in **Docker
Compose**, uploads on the **local VPS filesystem**. No AWS, no S3 requirement, no dealer/partner,
inventory, OTP or SMS architecture. Product features are not redesigned.

> A single VPS is **not highly available**. If it dies, the platform is down until it is rebuilt
> and restored. Backups, restore drills and external monitoring are what make this acceptable.

## Baseline (start of phase)

| Check                         | Result                                             |
| ----------------------------- | -------------------------------------------------- |
| Unit (`pnpm test`)            | 242 passed                                         |
| Integration (`pnpm test:e2e`) | 178 passed (17 suites)                             |
| Playwright                    | 49 passed at end of Phase 6 (no code change since) |
| CI                            | none in the repository                             |

## Review findings

| Area             | Finding                                                                                                                                                                       | Phase 7 action                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compose          | Dev compose publishes 5432/6379; `--profile full` runs containers with dev settings.                                                                                          | Keep for dev. New **standalone** `docker-compose.prod.yml`: private network, only the edge proxy publishes 80/443.                               |
| Nginx            | Each SPA image has an nginx that serves the app and proxies `/api`; basic headers, no CSP/HSTS, no TLS.                                                                       | Add an **edge** nginx container (TLS, Cloudflare real IP, host routing, limits, headers, CSP); SPA nginx gets CSP per app.                       |
| Client IP        | API supports `TRUST_PROXY` CIDRs and `CF-Connecting-IP`.                                                                                                                      | Edge verifies Cloudflare ranges with `real_ip`, **overwrites** `X-Forwarded-For`; API trusts only the private Docker subnet.                     |
| Storage          | `LocalStorageProvider` with server-generated keys + regex + resolve check; no symlink protection; files written non-atomically. S3 provider is a stub.                        | Symlink-safe (`O_NOFOLLOW`, realpath), atomic writes, startup writability check. Keep the provider interface; S3 stays optional.                 |
| Uploads          | Images decoded/re-encoded; PDFs structure-checked, active content rejected; no malware scanning.                                                                              | Optional **ClamAV** (clamd INSTREAM) for warranty PDFs before anything is written; `MALWARE_SCAN_ENABLED`.                                       |
| Health           | Single `/health` (DB + Redis).                                                                                                                                                | `/health/live`, `/health/ready` (Postgres required; Redis reported "degraded").                                                                  |
| Redis outage     | Cache reads fall back to Postgres, but public abuse checks and the global throttler call Redis directly → **public emergency pages would fail**; auth paths would return 500. | Public paths **fail open** (served from Postgres); auth/session/lockout paths **fail closed** with 503.                                          |
| Metrics          | None.                                                                                                                                                                         | Prometheus text endpoint (token-protected, blocked at the edge), low-cardinality labels only.                                                    |
| Worker health    | Heartbeat file + `worker_job_runs`.                                                                                                                                           | DB heartbeat table, job freshness in metrics and an admin **System status** card.                                                                |
| Config guards    | dev secrets, keys, cookie, proxy.                                                                                                                                             | + weak DB password, CORS (wildcard/HTTP/missing), HTTPS public URL, Swagger in production, shared secrets.                                       |
| Key rotation     | Keyrings support multiple versions; no re-encryption tool.                                                                                                                    | Offline, batched, restartable, audited `encryption:rotate` CLI.                                                                                  |
| Admin bootstrap  | Seed refuses production (good) — no production path.                                                                                                                          | One-time `admin:bootstrap` CLI (refuses if a SUPER_ADMIN exists).                                                                                |
| Images           | API image includes the full production `node_modules`.                                                                                                                        | Measure and trim; read-only root FS; non-root user; build metadata (version, SHA, date).                                                         |
| Backups / deploy | None.                                                                                                                                                                         | `backup.sh` (pg_dump custom + uploads archive + manifest + GFS retention), `restore.sh` (explicit confirmation), `deploy-vps.sh`, systemd timer. |

## Design

### Topology

```
Internet ─► Cloudflare (proxied DNS, Full (strict) TLS, WAF)
              │ 443
              ▼
VPS ── UFW: 22, 80, 443 only
   edge (nginx:alpine) :80/:443  ── TLS (Cloudflare Origin CA or Let's Encrypt)
     ├─ admin.example.com  ─► admin  (nginx: SPA + /api → api:4000)
     ├─ safe.example.com   ─► portal (nginx: SPA + /e, /verify + /api → api:4000)
     └─ api.example.com    ─► api:4000   (optional direct API host)
   api ── worker ── postgres:5432 ── redis:6379   (private "backend" network, no published ports)
   clamav (optional profile) · prometheus/alertmanager/exporters (optional "monitoring" profile)
```

Host layout: `/opt/helmet-platform` (checkout: compose, scripts, configs) · `/srv/helmet-platform/
{postgres,redis,uploads,backups}` (data, never inside the checkout) · `/etc/helmet-platform/
{app.env,compose.env,tls/}` (secrets, mode 600/700).

### Client IP chain (no blind X-Forwarded-For trust)

1. Edge nginx: `set_real_ip_from <Cloudflare ranges>; real_ip_header CF-Connecting-IP;` — the
   header is honoured **only** when the TCP peer is Cloudflare. Then
   `proxy_set_header X-Forwarded-For $remote_addr` (overwrite, never append client input) and
   `CF-Connecting-IP ""` (stripped).
2. SPA nginx appends its peer (the edge) → `X-Forwarded-For: <client>, <edge>`.
3. API: `TRUST_PROXY=<docker subnet>`, `TRUST_CLOUDFLARE=false` → `req.ip` = verified client.

Optional origin lock: an include restricting 80/443 to Cloudflare ranges at the edge (SSH is never
behind Cloudflare). Trade-offs in VPS-DEPLOYMENT.md.

### Redis dependency policy

| Path                                                                                | Redis down                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Public emergency / verify / photo (known token)                                     | served from PostgreSQL; caching, abuse throttling and scan dedup skipped |
| Route throttler `public` / `default`                                                | fail open (logged + metric)                                              |
| Route throttler `auth`, lockouts, recent-auth, session revocation, recovery tickets | fail **closed**: `503 SERVICE_UNAVAILABLE` (never "allow")               |
| Worker                                                                              | jobs continue; invalid-token counter treated as 0                        |
| Readiness                                                                           | 200 `degraded` (Postgres is the hard dependency)                         |

### Connection budget (PostgreSQL `max_connections=100`)

API `connection_limit=10` × up to 2 replicas + worker `connection_limit=5` (+1 advisory-lock
transaction) + backups/psql/migrations (≈ 5) + exporter (2) ≈ **38 < 100**. No PgBouncer needed.

### Secrets

Production env lives in `/etc/helmet-platform/app.env` (600). Compose references it with
`env_file`; nothing secret in YAML. Inventory in VPS-DEPLOYMENT.md; startup rejects reused or dev
secrets. **Medical encryption keys must be backed up separately** — without them the encrypted
medical fields in any database backup are unrecoverable.

## Delivered

### Application

- **Health:** `/health/live` (process), `/health/ready` (PostgreSQL required, 3 s timeout;
  Redis down → 200 `degraded`); `/health` kept as an alias.
- **Redis outage policy** (table above): `enableOfflineQueue:false`, 2 s connect/command
  timeouts, narrow outage classification (`isRedisUnavailableError`). Public abuse checks and the
  route throttler fail open on public routes; `auth` throttle, lockouts and sessions fail closed
  with 503. Dependency 503s are logged as one compact line at most every 10 s.
- **Argon2 concurrency limiter:** `ARGON2_MAX_CONCURRENCY` (1) / `ARGON2_MAX_QUEUE` (16) per
  API process. Interactive verifications beyond the queue get 503 "busy". Batch PIN hashing waits.
  Added after the login-flood load test (below).
- **Metrics:** in-house Prometheus registry, route-template labels only;
  `/api/v1/internal/metrics` with a timing-safe bearer `METRICS_TOKEN` (404 without a token,
  blocked at the edge). HTTP, dependency-outage, upload, audit-event, hash-rejection, worker,
  job, alert, DB/Redis-up and build-info series.
- **Worker health:** `worker_heartbeats` table (migration
  `20261010090000_phase7_worker_heartbeat`), 30 s DB heartbeat, pruned after 7 days; admin
  **System status** card; graceful SIGTERM.
- **Version:** `APP_VERSION`, `GIT_SHA`, `BUILD_DATE` baked into the images, shown in the
  admin footer and in `helmet_build_info`.
- **Storage:** `LocalStorageProvider` hardened: startup writability probe (fails fast),
  realpath containment, `O_NOFOLLOW|O_EXCL` atomic writes (temp file then rename), 0700/0600.
  The `FileStorageService` interface and the optional S3-compatible provider are unchanged; S3 is
  not required.
- **Malware scanning (optional):** clamd INSTREAM for warranty PDFs before storage
  (`MALWARE_SCAN_ENABLED`, `clamav` compose profile). Fails closed (503) when enabled and
  unreachable.
- **Production config guards:**
  - weak or default DB passwords;
  - CORS that is missing, a wildcard or plain HTTP;
  - a non-HTTPS or localhost QR base URL;
  - Swagger without explicit opt-in;
  - any two of the six secrets equal;
  - a data key reused as an escrow key.
- **CLI** (`node dist/cli.js`): `admin:bootstrap` (once; refuses if a SUPER_ADMIN exists;
  password on stdin; audited), `encryption:status`, and `encryption:rotate --keyring data|escrow`
  (batched, restartable, optimistic, audited).
- **Logging:** extended redaction (tokens, transfer codes, credentials, DOB, phones,
  contacts, ciphertexts, `DATABASE_URL`), QR tokens masked in URLs, health/metrics not logged.
- **Headers:** API sends `default-src 'none'; frame-ancestors 'none'` and no HSTS (the edge sets
  it). Emergency page inline styles moved to classes so the strict CSP holds.

### Infrastructure (`docker-compose.prod.yml`, `deploy/`, `scripts/`)

- **Compose:** standalone production file. Only the edge publishes 80/443. Networks:
  `backend` and `monitoring` are internal; `egress` exists only for clamav and alertmanager.
  `env_file` secrets (none in the YAML). Bind mounts under `DATA_ROOT`.
  - Every service: `no-new-privileges`, memory limits, `restart: unless-stopped`, json-file logs
    capped at 5 × 20 MB.
  - api, worker, admin, portal and edge also run with a read-only root filesystem plus tmpfs and
    `cap_drop: ALL`. api, worker and the SPAs run as non-root users. The edge keeps only the
    capabilities nginx needs to bind 80/443 and drop to its worker user.
  - postgres and redis use their official images' own privilege dropping.
- **Edge nginx:**
  - TLS, and Cloudflare `real_ip` honoured only from Cloudflare ranges;
  - `X-Forwarded-For` overwritten and `CF-Connecting-IP` stripped;
  - optional origin lock (`geo` on `$realip_remote_addr` → 444); 444 for unknown hosts;
  - HSTS, per-IP `limit_req`/`limit_conn`;
  - JSON access log without IPs, with QR tokens masked;
  - upstreams re-resolved through Docker DNS; internal metrics → 404.
- **SPA nginx:** unprivileged image on :8080, per-app CSP (strict on `/e/` and `/verify/`),
  12 MB body limit, no access log.
- **API image:** 898 MB → **676 MB** (`node_modules` 415 → 248 MB). Changes:
  - pruned sources, tests, source maps, `.d.ts` files, non-musl sharp builds, unused Prisma
    engines and typescript;
  - root-owned `/app`, `USER node`, health check;
  - migrations only when `RUN_MIGRATIONS_ON_START=true` (dev); production runs
    `migrate deploy` as a one-off step.
  - Admin and portal images are about 78 MB each.
- **Scripts:**
  - `deploy-vps.sh`: preflight, backup, build or pull, migrate, `up --wait`, smoke checks,
    `--rollback`, `releases.log`. It never deletes volumes, resets the DB or runs `db push`.
  - `compose.sh`: pins the deployed release.
  - `backup.sh`: `pg_dump -Fc` validated, uploads archive, manifest, checksums, atomic publish,
    GFS retention, metrics, optional offsite command.
  - `restore.sh`: checksums verified, `--confirm <project>` required, uploads moved aside rather
    than deleted.
  - `restore-drill.sh`: isolated project, compares counts with the manifest.
  - `vps-prepare.sh`, `update-cloudflare-ips.sh`.
  - All pass shellcheck.
- **systemd:** `helmet-backup.timer` (daily 02:15 UTC).
- **Monitoring profile:** Prometheus (localhost only), Alertmanager, node, postgres and redis
  exporters; 23 alert rules (promtool-validated), example receiver (amtool-validated).
- **CI** (`.github/workflows/ci.yml`, no deployment):
  - quality: format, lint, typecheck, unit;
  - integration on fresh Postgres and Redis: `migrate deploy`, drift check, e2e;
  - Playwright;
  - Docker image builds and prod-compose validation;
  - edge `nginx -t`, promtool and shellcheck.
- **Load testing:** `loadtest/seed.mjs` (refuses without `SEED_CONFIRM=staging`),
  `loadtest/k6/scenarios.js`, `loadtest/run-with-sampling.sh`.

### Docs

[VPS-DEPLOYMENT](VPS-DEPLOYMENT.md) · [DISASTER-RECOVERY](DISASTER-RECOVERY.md) ·
[INCIDENT-RESPONSE](INCIDENT-RESPONSE.md) · [MONITORING](MONITORING.md) ·
[DATA-INVENTORY](DATA-INVENTORY.md) · [LAUNCH-CHECKLIST](LAUNCH-CHECKLIST.md) ·
runbooks: [public emergency outage](runbooks/public-emergency-outage.md),
[manufacturing](runbooks/manufacturing.md), [compromised QR](runbooks/compromised-qr.md).

## Staging environment used for verification

The production compose file, unchanged, ran as project `helmet-stage` on one host (4 vCPU,
16 GB, shared with the load generator). Configuration:

- edge bound to 127.0.0.1 with a self-signed certificate, for `admin.`, `safe.` and `api.helmet.test`;
- production-style env files with the production guards active;
- `DATA_ROOT` bind mounts.

Seeded through the public API: 1,300 helmets, 300 activated customers with emergency profiles and
contacts, 20 with photos and warranty proofs. This is not the real VPS: Cloudflare, real TLS, UFW
and the physical QR test remain to be done on production (LAUNCH-CHECKLIST).

<a id="load-test"></a>

## Load test

k6 ran inside the Docker network against the SPA/edge path, with API limits of 1.5 CPU and
768 MB and Postgres limited to 1.5 GB. All traffic came from one IP, so for these runs only the
per-IP public limits were raised on staging; production limits were restored afterwards. These
are **measured** numbers for this host, not guarantees for a smaller VPS.

| Scenario                       | Rate                          | Result                                                                                 |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------- |
| Emergency, cached              | 200/s                         | p50 2 ms · p95 4.7 ms · p99 14 ms · 0 errors                                           |
| Emergency, cached              | 500/s                         | p95 19.6 ms · p99 39 ms · 0 errors                                                     |
| Emergency, cached              | 1,000/s target                | saturates at about **820/s** on one API container; latency queues, 0 errors            |
| Emergency, uncached (DB)       | 25/s                          | p95 12.9 ms                                                                            |
| Verify                         | 50/s                          | p95 6.9 ms                                                                             |
| Customer login (Argon2id)      | 5/s                           | p95 216 ms; capacity about **5–7.5 logins/s per API container**                        |
| Customer dashboard             | 30/s                          | p95 20 ms                                                                              |
| Admin analytics                | 5/s                           | p95 22 ms                                                                              |
| Mixed (all of the above)       | about 145/s                   | 0 errors; emergency cached p95 13 ms; max 357 ms                                       |
| **Login flood** before limiter | 100/s emergency + 15/s logins | emergency cached **p95 590 ms, p99 3.8 s**                                             |
| **Login flood** after limiter  | same                          | emergency cached **p95 9.5 ms, p99 42 ms**; 535 excess logins got 503 (metric matched) |

Peak PostgreSQL connections were 16 (budget 100); Redis used about 1.8 MB. Edge flood: 600
parallel requests from one IP → 254 × 200 and the rest 429.

**Capacity guidance:** one API container comfortably serves hundreds of emergency scans per second.
Logins (Argon2id) are the limiting resource. Add a second API replica (`API_REPLICAS=2`) before
raising the Argon2 concurrency.

<a id="failure-tests"></a>

## Failure tests

| Failure                             | Observed behaviour                                                                                                                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis stopped                       | Emergency page 200 from PostgreSQL (42 ms); verify 200; unknown token 404; readiness `degraded`; customer and admin login **503** (clean); worker `--once all` succeeded; recovered after restart. Also covered by the integration test `phase7-ops`. |
| PostgreSQL stopped                  | Readiness 503, liveness 200; recently cached emergency page still served from Redis (8 ms); uncached → clean 503; static pages and edge fine; worker `--once` exits 1; recovered about 4 s after restart.                                             |
| Worker stopped                      | API, logins and emergency pages unaffected; System status showed the worker not alive after 91 s; after restart all three jobs caught up in 11 s.                                                                                                     |
| API graceful restart under traffic  | 40/40 requests 200 (slowest 1.03 s; one earlier run saw a single 502 during the switch).                                                                                                                                                              |
| API process crash                   | Restarted by Docker in 6 s.                                                                                                                                                                                                                           |
| Full `down` / `up --force-recreate` | 40 upload files persisted (UID 1000, mode 600). Proof: owner 200, other customer 404, anonymous 401. Photo privacy toggle respected (404 hidden, 200 visible).                                                                                        |
| Uploads directory lost              | Photo and proof 404; `restore.sh --uploads-only` restored both with authorisation intact.                                                                                                                                                             |

## Backup and restore drills

See [DISASTER-RECOVERY → verified results](DISASTER-RECOVERY.md#verified-results-phase-7-staging-stack-on-the-production-compose-file).

- Full drill passed in 15 s: 9/9 table counts and 80/80 files matched; customer login, decrypted
  medical profile, byte-identical owner-only proof, admin analytics and audit all checked on the
  restored copy.
- **Not done:** an offsite copy (no target exists in the test environment) and a rebuild on a new
  VPS. **OFFSITE BACKUP REQUIRED FOR PRODUCTION.**

## Migrations

- Fresh database: `migrate deploy` applied all migrations; drift check exit 0.
- Upgrade: a Phase 6 database with Phase 4–6 data → Phase 7 applied the heartbeat migration,
  with counts unchanged.
- The existing dev database is up to date with no drift. No `migrate reset` or `db push` is used
  anywhere in production tooling.

<a id="dependency-audit"></a>

## Dependency audit

`pnpm audit`: **before** 4 critical, 5 high, 5 moderate → **after** 0 critical, 2 high,
1 moderate.

| Fixed                                       | How                              |
| ------------------------------------------- | -------------------------------- |
| sharp (libvips CVEs)                        | `^0.35.5`; image tests pass      |
| handlebars (critical, via a dev tool chain) | override `^4.7.10`               |
| js-yaml 5.x prototype pollution             | override `^5.4.1`                |
| vite/esbuild via vitest                     | vitest `^4.1.11` (admin, portal) |

| Accepted (remaining)                 | Why                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| deepmerge-ts (high)                  | Prisma CLI config loader, trusted input only; fixed in Prisma 7 (major upgrade, later) |
| braces (high), sprintf-js (moderate) | jest dev-only toolchain, no patched release in range; never in the runtime image       |

## Security review

- **Raw SQL:** only the CLI interpolates constant column names; everything else is
  parameterised.
- **Frontend:** no XSS sinks (`dangerouslySetInnerHTML`, `innerHTML` with data); no secrets in
  the built bundles.
- **Guards:** every route carries a guard except the intentional public ones (emergency, verify,
  photo, product report, auth, health).
- **CORS:** foreign origins rejected.
- **Refresh cookie:** HttpOnly, Secure, SameSite=Strict, path-scoped; refresh without
  `X-Requested-With` → 403.
- **No login enumeration:** same message for every failure; a dummy Argon2 run equalises timing;
  the auth throttle applies.
- **Client IP:** spoofed `X-Forwarded-For`, `CF-Connecting-IP` and `X-Real-IP` are ignored from
  non-Cloudflare peers; honoured from a simulated Cloudflare peer; the origin lock closes other
  peers; no raw IPs in the DB.
- **Log audit** (1,330 lines across all containers after the load and failure tests): zero
  passwords, tokens, emails, JWTs, medical values, phones or IPs; QR tokens masked.
- **Browser CSP check** against the production build through the edge (Playwright): `/e/`,
  `/verify/`, portal helmet page and admin dashboard/analytics show **no CSP violations**; fonts
  load; admin footer shows version and commit.
- **Edge exposure:** metrics 404; unknown host closed (444); no directory listing; uploads never
  served directly; only 80/443 published.

## Verification summary

| Gate                                                                   | Result                                      |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| Format / lint / typecheck                                              | pass                                        |
| Unit (`pnpm test`)                                                     | **302** passed                              |
| Integration (`pnpm test:e2e`, `--runInBand`)                           | **184** passed (18 suites)                  |
| Playwright                                                             | **49** passed                               |
| Build (`pnpm build`) / Docker images                                   | pass (api 676 MB, admin/portal about 78 MB) |
| Prod compose validation, edge `nginx -t`, promtool, amtool, shellcheck | pass                                        |
| Fresh migrations + drift / upgrade from Phase 6                        | pass                                        |
| Backup / restore drill / uploads-only restore                          | pass (local only, offsite **not** tested)   |
| Redis outage / Postgres outage / worker restart / API restart / crash  | pass (table above)                          |
| Container restart persistence                                          | pass                                        |
| Load tests                                                             | done (table above)                          |
| Dependency audit / security review                                     | done (above)                                |

## Remaining production blockers and conditions

1. **Offsite backup** configured, encrypted, history-protected, with a **tested restore from it**.
2. **External uptime monitoring**, with phone alerts for the emergency page.
3. Real VPS + Cloudflare + TLS validation (LAUNCH-CHECKLIST infrastructure section).
4. **Physical QR test** with printed production labels on real phones.
5. Offline keyring copy held by two people.
6. Decisions to record: ClamAV on or off; origin lock versus Cloudflare fallback; alert receiver
   for Alertmanager.
7. Privacy: account deletion does not yet erase data; retention and erasure decisions are needed
   before launch (DATA-INVENTORY).

**Technical debt noted:**

- Batch PIN generation is serialised by `ARGON2_MAX_CONCURRENCY=1`; large batches take minutes.
  The worker could take over generation with its own limiter.
- Prisma 7 upgrade (removes the remaining deepmerge-ts finding and the `package.json#prisma`
  deprecation).
- A single VPS is not highly available.

## Readiness

**READY WITH CONDITIONS.** The software, deployment tooling, backups (local), restore procedure,
monitoring hooks and runbooks are in place and verified on a staging stack using the production
compose file. It is **not** disaster-safe until an offsite backup exists and has been restored,
and outages would go unnoticed without external uptime monitoring.
