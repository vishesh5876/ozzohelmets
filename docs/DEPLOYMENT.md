# Deployment

Phase 1 ships container images and a compose file; AWS infrastructure is deliberately out of
scope until Phase 7.

## Images

| Image          | Dockerfile                                                | Notes                                                                                                                                                                                                                                  |
| -------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API            | `apps/api/Dockerfile`                                     | Multi-stage; `pnpm deploy --prod` tree on `node:22-bookworm-slim`, runs as `node`. On start: `prisma migrate deploy && node dist/main.js`. Healthcheck `GET /api/v1/health`. Run with an init process (`init: true`).                  |
| (API storage)  | volume at `/app/storage`                                  | Local profile-photo storage (`FILE_STORAGE_LOCAL_DIR`). Use a persistent volume, or implement the S3 provider for multi-instance deployments.                                                                                          |
| Admin / Portal | `docker/spa.Dockerfile` (`--build-arg APP=admin\|portal`) | Vite build served by nginx; `/api/` proxied to `API_UPSTREAM` (default `http://api:4000`); immutable caching for hashed assets, `no-cache` for `index.html`; security headers. Portal accepts `--build-arg VITE_EMERGENCY_NUMBER=112`. |

Build context is always the repo root:

```bash
docker build -f apps/api/Dockerfile -t helmet-api .
docker build -f docker/spa.Dockerfile --build-arg APP=admin -t helmet-admin .
docker build -f docker/spa.Dockerfile --build-arg APP=portal -t helmet-portal .
```

## Full stack locally

```bash
docker compose --profile full up -d --build
docker compose exec api npx prisma db seed   # optional: dev seed (not in production)
```

The containerised API defaults to `NODE_ENV=development` so the dev-only placeholder secrets in
`.env.example` are accepted. For a production-like run set real secrets and
`API_CONTAINER_NODE_ENV=production` (startup validation rejects dev-only secrets and
`COOKIE_SECURE=false`).

## Production checklist

- [ ] Real secrets from a secret manager (`node scripts/generate-secrets.mjs` for initial values);
      `PIN_ESCROW_KEYS` and `DATA_ENCRYPTION_KEYS` stored separately from DB credentials.
- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true`, `SWAGGER_ENABLED=false` (or edge-protected).
- [ ] `JWT_CUSTOMER_ACCESS_SECRET` (≠ `JWT_ACCESS_SECRET`) and `CUSTOMER_CREDENTIAL_PEPPER` set from
      the secret manager. **Never rotate the pepper casually** — it invalidates every customer
      password and recovery code.
- [ ] Persistent photo storage (volume or S3 provider) and backups for it.
- [ ] Phase 3: review `RECENT_AUTH_TTL_SECONDS` (300) and `TRANSFER_*` (code TTL, lockouts); apply
      migration `20261003162224_phase3_ownership_lifecycle` with `prisma migrate deploy`.
- [ ] `CORS_ORIGINS` = exact admin/portal origins; `PUBLIC_EMERGENCY_BASE_URL` = final QR domain
      (**printed into labels — choose it once**; changing it later breaks printed QR codes unless
      the old domain redirects).
- [ ] `TRUST_PROXY` matching the load balancer hops; `TRUST_CLOUDFLARE=true` only if the origin
      accepts traffic exclusively from Cloudflare. Enforced at startup in production (Phase 6, see
      below).
- [ ] Run at least one **worker** (`node dist/worker.js`, same image as the API).
- [ ] Managed PostgreSQL with PITR backups; Redis with persistence or acceptance that rate-limit/
      cache state is ephemeral.
- [ ] Run migrations as a one-off job before rolling out new API versions (the image also runs
      `migrate deploy` on start, which is safe but serialises on the migrations lock).
- [ ] Log shipping (JSON stdout) and alerting on 5xx rate, `admin.refresh.reuse_detected`,
      `admin.login.locked` and batch generation failures.
- [ ] Cloudflare/CDN: cache static assets; do **not** cache `/api/v1/public/emergency/*`
      responses (they are `no-store`; privacy changes must apply immediately). `/e/*` serves
      `emergency.html` (`no-cache`).

## Scaling notes

- API is stateless; scale horizontally. Rate limits and caches are shared through Redis.
- Batch generation runs in the API process that claimed the batch (atomic claim prevents
  duplicates; abandoned jobs are marked FAILED after 5 min and can be resumed). For very large
  volumes move it to a dedicated worker/queue (no schema change needed). Argon2 runs on the libuv
  pool — consider `UV_THREADPOOL_SIZE` ≥ 8 on generation-heavy instances.

## AWS (Phase 7 sketch)

ECS Fargate (API, SPAs or S3+CloudFront for SPAs), RDS PostgreSQL, ElastiCache Redis, KMS
envelope encryption for keyrings, Secrets Manager, ALB + Cloudflare, CloudWatch/OTel.

## Phase 5 configuration

- `RECOVERY_GRANT_TTL_MINUTES` (60), `SECURITY_EVENT_RETENTION_DAYS` (365).
- Public abuse controls: `PUBLIC_MISS_LIMIT_PER_IP` (30), `PUBLIC_MISS_WINDOW_SECONDS` (600),
  `PUBLIC_UNCACHED_LIMIT_WHEN_FLAGGED` (10), `PUBLIC_GLOBAL_MISS_LIMIT_PER_MINUTE` (3000);
  `THROTTLE_PUBLIC_LIMIT` default raised to 300. Make sure the real client IP reaches the API
  (`TRUST_PROXY` / `TRUST_CLOUDFLARE`), otherwise every visitor shares one IP budget.
- `HELMET_HIGH_SCAN_THRESHOLD_24H` (50) for the informational admin flag.
- The Phase 5 migration runs `CREATE EXTENSION IF NOT EXISTS pg_trgm`; the database role needs
  permission to create it (or pre-create it as a superuser on managed PostgreSQL).

## Phase 6 configuration

### Worker

Run `node dist/worker.js` from the API image (compose service `worker`). It needs the same
`DATABASE_URL`, `REDIS_URL` and secrets as the API, no ports, and an init process. Several replicas
are safe (advisory locks). Healthcheck: mtime of `/tmp/helmet-worker-heartbeat` < 2 min. See
[WORKER](WORKER.md). Without a worker the API keeps serving, but dashboards stop updating, risk
signals aren't evaluated and retention doesn't run.

### Client IP behind proxies (required for abuse detection)

Per-source limits and alerts are only as good as the client IP the API sees.

| Setup                                 | Settings                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Load balancer / reverse proxy (1 hop) | `TRUST_PROXY=1` (or the proxy CIDRs, e.g. `10.0.0.0/8`)                                                           |
| Cloudflare → LB → API                 | `TRUST_CLOUDFLARE=true` **and** origin firewall allowing only Cloudflare IP ranges; `TRUST_PROXY` for the LB hops |
| API exposed directly (no proxy)       | `TRUST_PROXY=false`, `REQUIRE_TRUSTED_PROXY_IN_PRODUCTION=false`                                                  |

- `TRUST_PROXY=true` is **rejected in production**: Express would trust any `X-Forwarded-For`
  value, letting a client pick its own IP and dodge every per-source limit.
- With `NODE_ENV=production` and no trusted proxy, startup fails unless
  `REQUIRE_TRUSTED_PROXY_IN_PRODUCTION=false` — behind a load balancer every visitor would
  otherwise share the balancer's IP.
- At runtime, if `X-Forwarded-For` or `CF-Connecting-IP` arrive while nothing is trusted, the API
  logs `ClientIp` errors (at most every 10 minutes): fix the configuration.
- `CF-Connecting-IP` is honoured only with `TRUST_CLOUDFLARE=true`; never enable it on an origin
  reachable without Cloudflare.

### Variables

Scan recording and retention (`SCAN_RECORDING_ENABLED`, `SCAN_DETAIL_RETENTION_DAYS` 180,
`ANALYTICS_AGGREGATE_RETENTION_DAYS` 0 = keep, `WORKER_JOB_RUN_RETENTION_DAYS` 30), risk thresholds
(`RISK_*`, see [RISK-ENGINE](RISK-ENGINE.md)), source detection (`ENUMERATION_INVALID_TOKEN_LIMIT`
50, `VALID_TOKEN_SCRAPE_LIMIT` 100, `VALID_TOKEN_SCRAPE_WINDOW_SECONDS` 3600,
`VALID_TOKEN_SCRAPE_BLOCK_MULTIPLIER` 5) and job intervals (`RISK_EVALUATION_INTERVAL_MINUTES` 5,
`ANALYTICS_AGGREGATION_INTERVAL_MINUTES` 10, `RETENTION_INTERVAL_MINUTES` 60). All in
`.env.example`.
