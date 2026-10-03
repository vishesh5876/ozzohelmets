# Phase 1 — Foundation + manufacturing

Status legend: `[x]` done · `[ ]` pending

## Repository & tooling

- [x] pnpm workspace monorepo (`apps/*`, `packages/*`)
- [x] Shared `tsconfig` bases (strict) and flat ESLint config, Prettier
- [x] `.env.example` (no secrets committed), `.gitignore`
- [x] `@helmet/types` shared enums/contracts, `@helmet/ui` shared primitives + theme

## Infrastructure

- [x] `docker-compose.yml`: PostgreSQL 16, Redis 7 (default); api/admin/portal (profile `full`)
- [x] Dockerfiles: API (multi-stage), admin + portal (static build served by nginx with `/api` proxy)
- [x] Zod environment validation at startup; typed config service
- [x] Structured logging (pino) with redaction
- [x] Secure headers (helmet), CORS allow-list, trust proxy / Cloudflare client IP
- [x] Redis-backed rate limiting (named throttlers)
- [x] Consistent success/error envelope; no stack traces in production
- [x] Swagger at `/api/docs` (env-toggle), API versioning `/api/v1`
- [x] Health endpoint (DB + Redis)

## Database (Prisma migrations, no `db push`)

- [x] `admin_users`, `admin_refresh_tokens`
- [x] `helmet_models`, `helmet_batches` (generation status/progress), `helmets`
- [x] `helmet_activation_secrets` (encrypted PIN escrow)
- [x] `helmet_status_history`, `helmet_scans`, `audit_logs`
- [x] `users`, `helmet_ownerships` (schema only, for Phase 2)
- [x] Unique constraints + indexes (helmetCode, publicToken, serialNumber, status, batchId)
- [x] Seed: SUPER_ADMIN from env, sample models, sample batch, generated helmets

## Security primitives

- [x] CSPRNG identifier generator (rejection sampling, no modulo bias)
- [x] Helmet ID `HM-XXXX-XXXY` with check symbol + validator
- [x] Public token ≥128 bits
- [x] Activation PIN generation + Argon2id (peppered) hashing/verification
- [x] AES-256-GCM encryption service with key versioning
- [x] HMAC IP hashing

## Admin auth & RBAC

- [x] Login (Argon2id), JWT access token, rotating refresh token (hashed, family reuse detection)
- [x] Logout / revoke; login attempt lockout
- [x] Roles: SUPER_ADMIN, ADMIN, MANUFACTURING, SUPPORT, ANALYTICS_VIEWER
- [x] `@Roles()` and `@RequirePermissions()` decorators + guard (backend-enforced)
- [x] Admin users management (SUPER_ADMIN)

## Manufacturing

- [x] Helmet models CRUD (create/list/update/archive)
- [x] Batches: create (auto `BAT-YYYY-NNNNN` code), list, detail
- [x] Generate helmets: claim, chunked transactional inserts, collision retry, progress, resume
- [x] Mark batch printed → purge PIN escrow (audited)

## Helmets

- [x] List with search (code/serial) and filters (status, batch, model), pagination
- [x] Detail with status history
- [x] Status transition domain service + admin status change endpoint
- [x] QR (SVG/PNG) + Code128 (SVG/PNG) endpoints

## Export

- [x] Manufacturing CSV (helmetCode, serialNumber, model, batchCode, qrUrl, activationPin)
- [x] Permission-gated (SUPER_ADMIN, ADMIN) and audited on every export

## Public

- [x] `GET /api/v1/public/emergency/:token` → public state only; scan logging; cache
- [x] Portal `/e/:token` page: "This helmet has not yet been activated."

## Frontend

- [x] Admin: login, dashboard, models, batches (create/generate/progress/export/mark printed),
      helmets (list/filter/detail/QR/barcode/status), audit logs, admin users
- [x] Portal: landing, `/e/:token`, placeholders for activation/login

## Tests

- [x] Unit: identifier generation uniqueness/format/checksum, token entropy & uniqueness, PIN
      hashing/verification, AES-GCM, status transitions, RBAC guard, enum sync
- [x] Integration (real Postgres + Redis): auth + refresh rotation/reuse, RBAC on export,
      model → batch → generate → list → CSV export → public resolution

## Docs

- [x] README, ARCHITECTURE, DATABASE, SECURITY, API, HELMET-LIFECYCLE, DEVELOPMENT, DEPLOYMENT

## Flagged business decisions (need product confirmation)

1. Which statuses may be activated directly by a customer (current: PRINTED, IN_INVENTORY, SOLD).
2. Meaning of ACTIVATED vs ACTIVE (current: ACTIVE once the owner completes the emergency profile).
3. Whether MANUFACTURING role may export PINs (current: no — SUPER_ADMIN/ADMIN only).
4. Serial number format (current: `<batchCode>-<6-digit unit index>`; not a secret).
5. PIN escrow purge trigger (current: batch marked PRINTED, PIN used, or manual purge).
