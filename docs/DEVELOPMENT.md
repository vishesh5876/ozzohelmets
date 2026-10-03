# Development

## Prerequisites

- Node.js ≥ 22 (`.nvmrc`), pnpm 10 (`corepack enable`)
- Docker (for PostgreSQL + Redis), or local PostgreSQL 16 and Redis 7

## First run

```bash
cp .env.example .env          # dev-only values; adjust ports if needed
pnpm install                  # also runs `prisma generate`
docker compose up -d          # PostgreSQL + Redis
pnpm prisma                   # apply migrations + seed (SUPER_ADMIN from SEED_* vars)
pnpm dev                      # API :4000, admin :3000, portal :3001
```

- Admin: http://localhost:3000 — sign in with `SEED_SUPER_ADMIN_EMAIL` / `SEED_SUPER_ADMIN_PASSWORD`.
- Portal: http://localhost:3001 — open a `qrUrl` from the CSV export or a helmet detail page.
  To activate in development: export the batch CSV (PIN column), mark the batch printed, move the
  helmet to SOLD on its admin page, open the QR URL → Activate → PIN → create a password → save the recovery code.
  Sign in later at `/login` with the Helmet ID + password; `/recover` resets it with the recovery code.
- The emergency page `/e/:token` is a separate lightweight entry (`apps/portal/emergency.html`,
  `src/emergency/main.ts`); the Vite dev server rewrites `/e/*` to it.
- Swagger: http://localhost:4000/api/docs

The Vite dev servers proxy `/api` to `VITE_API_PROXY_TARGET`, so the browser talks to one origin
(required for the SameSite=Strict refresh cookie).

## Layout & conventions

- `packages/types` is the contract between API and SPAs (enums, permissions, lifecycle table,
  identifier formats, DTO shapes). The SPAs import its TypeScript source; the API imports its
  compiled `dist` (built automatically by `predev`/`prebuild`/`typecheck`).
- API modules live in `apps/api/src/modules/<name>` with controller → service → Prisma. Shared
  infrastructure is in `config/`, `infrastructure/`, `common/`, `security/`.
- Never read `process.env` in app code — inject `AppConfigService`. Add new variables to
  `env.schema.ts` **and** `.env.example`.
- Never log secrets, PINs, tokens or medical data. Use `AuditService.record(entry, tx)` inside
  the transaction that performs a sensitive change.
- Status changes go through `HelmetStatusService` only.

## Scripts (root)

| Command                          | What it does                                    |
| -------------------------------- | ----------------------------------------------- |
| `pnpm dev`                       | All apps in watch mode                          |
| `pnpm build`                     | Build every package                             |
| `pnpm lint` / `pnpm typecheck`   | ESLint / `tsc --noEmit` everywhere              |
| `pnpm test`                      | Unit tests (API: Jest)                          |
| `pnpm test:e2e`                  | API integration tests (real PostgreSQL + Redis) |
| `pnpm format`                    | Prettier                                        |
| `pnpm prisma`                    | `migrate deploy` + seed                         |
| `pnpm prisma:migrate --name <x>` | Create & apply a new migration (dev)            |
| `pnpm prisma:studio`             | Prisma Studio                                   |

## Tests

- **Unit** (`apps/api/src/**/*.spec.ts`): identifier generation (format, checksum, uniqueness over
  100k, entropy, bias), PIN hashing, AES-GCM, status transitions, RBAC guard, error filter, env
  validation, CSV encoding, Prisma↔shared enum sync.
- **Integration** (`apps/api/test/*.e2e-spec.ts`): boots the full Nest app against database
  `helmet_platform_test` and Redis DB 15 (override with `TEST_DATABASE_URL` / `TEST_REDIS_URL`).
  Global setup runs `prisma migrate deploy` (creating the DB if needed); suites truncate their
  own data and refuse to run against a database whose name doesn't end in `_test`.
  Covered: login/lockout, refresh rotation and reuse detection, logout, RBAC per role, the
  whole manufacturing flow (generate ×2 concurrently, search, labels, CSV with PIN↔hash check,
  invalid transitions, mark printed/escrow purge), public endpoint privacy, scan logging, cache
  invalidation, rate limiting.

Phase 2 suites: `customer-auth` (Helmet ID + password login, multi-helmet login, lockouts, rotation, reuse, sessions, realm separation), `recovery` (recovery code reset, single use, rotation, session revocation, rate limits), `activation`
(validate, atomic first-account creation, add helmet, PIN reuse, **concurrent activation**, lockouts, budgets,
ineligible statuses), `emergency-profile` (encryption at rest, contacts, visibility, enable →
ACTIVE, public boundary, cache invalidation, photo, admin masking, disable, scan dedup) and
`customer-authorization` (customer A vs B on every resource).

Phase 3 suites: `ownership-transfer` (multi-helmet login, recent auth, atomic transfer, old
owner's data disappears, new-customer claim with recovery code, self-transfer, cancel/supersede,
expiry, blocked states, brute-force lockout, **two-recipient race**, **claim-vs-stolen race**,
DB uniqueness, cross-customer authorization) and `helmet-lifecycle` (per-helmet enablement,
lost/found restore rules, stolen/recovered, damaged, retirement, recent-auth expiry and
revocation, support permissions, restore, forced deactivation, revocation, replacement).

### Browser end-to-end (Playwright)

`e2e/tests/phase2-activation-emergency.spec.ts` drives the whole Phase 2 journey: admin creates a
model and batch → exports the CSV for the PIN → marks printed → moves the helmet to SOLD →
anonymous mobile scan shows "not activated" → activation with PIN + password → recovery code shown once → onboarding
(details, contact, visibility, review, enable) → anonymous scan shows only the approved fields →
logout → sign in with Helmet ID + password → account recovery with the recovery code → old password
and old recovery code rejected, new password works.

`e2e/tests/phase3-ownership-lifecycle.spec.ts` (Phase 3, 27 steps): two helmets manufactured
through the admin API → customer A (both helmets, emergency info on the first) signs in → starts
a transfer, confirms the password, gets the one-time code, signs out → a new customer claims with
Helmet ID + code, creates a password, saves the recovery code → A keeps only the other helmet and
the public page shows none of A's data → B onboards and the public page shows B's data → lost →
found → stolen (password) → transfer unavailable → recovered → damaged → retired → public page
"no longer active". Public pages are checked in a mobile viewport.

```bash
pnpm dev                     # in another terminal
pnpm test:e2e:browser
```

The journey makes many credential calls (activation, logins, recovery) from one IP. Repeated runs
can trip the `auth` throttle (10/min/IP, 5-minute block); raise `THROTTLE_AUTH_LIMIT` in your local
`.env` when iterating.

## Creating a migration

```bash
# edit apps/api/prisma/schema.prisma
pnpm prisma:migrate --name add_emergency_profiles
git add apps/api/prisma/migrations
```

For SQL Prisma can't express (partial indexes, CHECKs, sequences), use
`pnpm --filter @helmet/api prisma:migrate:create --name <x>`, edit the generated SQL, then apply.
