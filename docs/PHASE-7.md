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

## Delivered / verification

Filled in at the end of the phase.
