# Architecture

> Helmet Emergency Identity & Product Authentication Platform

## 1. Overview

Every physical helmet gets a cryptographically generated identity (internal UUID, public Helmet ID,
public QR token, one-time activation PIN, serial number) bound to a model/SKU and manufacturing
batch. Customers activate and own helmets; first responders scan the QR to see an emergency page
that shows only what the owner chose to publish. The brand uses an admin portal to manage
manufacturing, inventory and support.

```
┌────────────────────┐ ┌────────────────────┐ ┌──────────────────────────┐
│ React Admin Portal │ │ React Customer     │ │ Public Emergency Page    │
│ apps/admin  :3000  │ │ Portal apps/portal │ │ apps/portal  /e/:token   │
└─────────┬──────────┘ └─────────┬──────────┘ └────────────┬─────────────┘
          │      HTTPS / JSON  /api/v1/*                    │
          ▼                      ▼                          ▼
┌────────────────────────────────────────────────────────────────────────┐
│ NestJS API (modular monolith)  apps/api  :4000                         │
│  admin-auth · admin-users · helmet-models · batches · helmets ·        │
│  labels · exports · public-emergency · audit · dashboard · health      │
└──────────────┬───────────────────────────────────┬─────────────────────┘
               ▼                                   ▼
        ┌─────────────┐                     ┌─────────────┐
        │ PostgreSQL  │                     │ Redis       │
        │ (Prisma)    │                     │ rate limits,│
        │ source of   │                     │ cache, OTP, │
        │ truth       │                     │ locks       │
        └─────────────┘                     └─────────────┘
```

## 2. Why a modular monolith

- One deployable, one database, one transaction boundary — activation and batch generation need
  strong consistency, which is trivial in-process and hard across services.
- Each domain lives in its own NestJS module with an explicit public service API. Modules talk to
  each other only through exported services (never by reaching into another module's tables via
  ad-hoc queries in controllers). That keeps a later extraction (e.g. `public-emergency` as an
  edge-cached read service, or `batches` generation as a worker) mechanical.
- Cross-cutting infrastructure (config, Prisma, Redis, logging, crypto, rate limiting, error
  envelope) lives outside `modules/` and is injected.

## 3. Repository layout

```
helmet-platform/
├── apps/
│   ├── api/            NestJS + Prisma backend
│   │   ├── prisma/     schema.prisma, migrations/, seed.ts
│   │   ├── src/
│   │   │   ├── config/          zod-validated environment → typed AppConfig
│   │   │   ├── infrastructure/  prisma, redis, logging
│   │   │   ├── common/          error envelope, filters, interceptors, pagination, utils
│   │   │   ├── security/        random identifiers, argon2, AES-256-GCM, IP hashing, throttler storage
│   │   │   └── modules/         domain modules (one folder each)
│   │   └── test/       e2e/integration tests (real Postgres + Redis)
│   ├── admin/          React admin portal (Vite)
│   └── portal/         React customer portal + public emergency page (Vite)
├── packages/
│   ├── types/          shared enums, API contracts, identifier formats (TS, dual CJS/ESM entry)
│   ├── ui/             shared React primitives + Tailwind theme tokens
│   ├── tsconfig/       shared tsconfig bases
│   └── eslint-config/  shared flat ESLint config
├── docker/             nginx config for SPA containers
├── docs/
├── docker-compose.yml
└── pnpm-workspace.yaml
```

## 4. Backend module map

| Module                                                 | Responsibility                                                               | Phase     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | --------- |
| `health`                                               | liveness/readiness (DB + Redis)                                              | 1         |
| `audit`                                                | append-only audit log writer/reader; transaction-aware                       | 1         |
| `admin-auth`                                           | admin login, JWT access, rotating refresh tokens, guards, RBAC decorators    | 1         |
| `admin-users`                                          | admin user management (SUPER_ADMIN only)                                     | 1         |
| `helmet-models`                                        | models / SKUs                                                                | 1         |
| `batches`                                              | manufacturing batches, bulk identity generation job, PIN escrow purge        | 1         |
| `helmets`                                              | helmet registry, search/filter, lifecycle (status transition domain service) | 1         |
| `labels`                                               | QR (SVG/PNG) and Code128 barcode (SVG/PNG) rendering                         | 1         |
| `exports`                                              | manufacturing CSV export (role-gated, audited)                               | 1         |
| `public-emergency`                                     | unauthenticated QR resolution, scan logging, Redis cache                     | 1 (basic) |
| `dashboard`                                            | headline counts                                                              | 1         |
| `customer-auth`                                        | mobile OTP / email+password, customer JWT + refresh                          | 2         |
| `activation`                                           | atomic, row-locked activation flow                                           | 2         |
| `emergency-profile`                                    | encrypted medical profile, contacts, visibility                              | 2         |
| `ownership`                                            | transfer codes, history                                                      | 3         |
| `warranty`, `dealers`, `anti-counterfeit`, `analytics` | 4+                                                                           |

## 5. Request pipeline (API)

1. `helmet` secure headers, CORS allow-list from env, `trust proxy` (Cloudflare-aware client IP).
2. `nestjs-pino` structured logging with redaction (no bodies, no auth headers, no cookies).
3. Global `ValidationPipe` (whitelist + forbidNonWhitelisted + transform) on class-validator DTOs.
4. Redis-backed throttler with named limits (`default`, `auth`, `public`); per-route overrides.
5. Guards: `AdminJwtGuard` → `RbacGuard` (`@Roles()` / `@RequirePermissions()`).
6. `ApiResponseInterceptor` wraps results as `{ success: true, data, meta? }`.
7. `AllExceptionsFilter` emits `{ success: false, error: { code, message, details? } }` — never stack
   traces outside development.

## 6. Key architectural decisions (ADR summary)

| #   | Decision                                                                                                                                                                                                                                                                 | Rationale                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Modular monolith (NestJS)**                                                                                                                                                                                                                                            | Consistency for activation/generation; extraction path preserved.                                                                 |
| 2   | **Single UUID primary key per table** (`id`, UUIDv7). The spec's separate `uuid` column is folded into `id` for `Helmet` and `User`.                                                                                                                                     | A second UUID column duplicates the PK with no security gain; UUIDv7 keeps B-tree inserts local. IDs never appear in public URLs. |
| 3   | **Helmet ID format `HM-XXXX-XXXY`**: 7 random symbols + 1 check symbol (weighted mod-31 checksum; detects all single substitutions and adjacent transpositions) from the unambiguous alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`.                                         | Non-sequential, CSPRNG-generated, typo-detecting for manual/phone entry. Uniqueness enforced by DB unique constraint + retry.     |
| 4   | **Public QR token = 22 base62 chars (~131 bits)** from `crypto.randomBytes` with rejection sampling.                                                                                                                                                                     | Spec requires ≥128 bits; the 16-char example would only be ~95 bits.                                                              |
| 5   | **Activation PIN = 8 symbols (~39.6 bits) from the same alphabet**, stored as **Argon2id + server-side pepper**. Online guessing limited by rate limits and per-helmet attempt caps.                                                                                     | Printable, unambiguous, short enough to type.                                                                                     |
| 6   | **PIN escrow for manufacturing export**: plaintext PIN is encrypted (AES-256-GCM, dedicated `PIN_ESCROW_KEY`) in a separate `helmet_activation_secrets` table until the batch is marked printed or the PIN is used; then purged. Export is permission-gated and audited. | Labels must be printable (and reprintable) after async generation without ever storing plaintext. See `SECURITY.md`.              |
| 7   | **Async in-process batch generation** with DB-tracked progress, atomic "claim" of the batch, chunked `createMany` transactions, resumable.                                                                                                                               | No queue infra needed in Phase 1; idempotent design allows moving to BullMQ/worker later.                                         |
| 8   | **Labels rendered on demand** (QR SVG/PNG, Code128) from DB data, not stored.                                                                                                                                                                                            | Deterministic, no blob storage, no drift.                                                                                         |
| 9   | **Status transitions via a pure domain service** with actor-scoped rules (`SYSTEM`, `ADMIN`, `OWNER`) + `helmet_status_history`.                                                                                                                                         | Lifecycle invariants live in one tested place.                                                                                    |
| 10  | **Admin refresh tokens**: opaque 256-bit, SHA-256 hashed at rest, rotated on every use, family-based reuse detection, httpOnly `SameSite=Strict` cookie scoped to the refresh path. Access JWT (15 min) kept in memory by the SPA.                                       | Mitigates XSS token theft and replay.                                                                                             |
| 11  | **Separate `admin_users` table** from customer `users`.                                                                                                                                                                                                                  | Spec requirement; different auth surfaces and lifecycles.                                                                         |
| 12  | **Shared `@helmet/types` package** — enums and response contracts used by API and both SPAs; a unit test asserts Prisma enums stay in sync.                                                                                                                              | Single source for client/server contracts.                                                                                        |
| 13  | **Public emergency page in the portal SPA (Phase 1)** as a lazily-loaded, dependency-light route.                                                                                                                                                                        | Simple now. Phase 2 re-evaluates a server-rendered/edge-cached HTML page for minimal JS (flagged).                                |
| 14  | **Dev ports & URLs from env only**; Vite dev proxy for `/api`, nginx proxy in containers.                                                                                                                                                                                | No hard-coded URLs, same-site cookies.                                                                                            |
| 15  | **Prisma 6 / NestJS 11 / TypeScript 5.9 / React 19 / Vite 7 / Tailwind 4** pinned to proven majors.                                                                                                                                                                      | Newer majors (Prisma 7/8, TS 7) were available but change runtime/tooling contracts; we chose stability.                          |

## 7. Data flow: batch generation

```
Admin "Generate" ─► POST /admin/batches/:id/generate
                     │ atomic UPDATE ... SET generation_status='GENERATING'
                     │   WHERE id=? AND generation_status IN ('PENDING','FAILED')  (claim)
                     ▼ 202 Accepted (job runs in background)
   loop chunks of N (default 500) until generated_count = quantity:
     generate PINs  → argon2id hash (bounded concurrency) → AES-GCM escrow
     generate codes/tokens/serials
     $transaction: helmets.createMany + secrets.createMany + status history
                   + UPDATE batch.generated_count
     on unique collision (P2002): regenerate codes/tokens for the chunk, retry (max 5)
   COMPLETED (audit) | FAILED (error recorded, resumable)
Admin UI polls GET /admin/batches/:id for progress.
```

## 8. Data flow: public QR scan (Phase 1)

```
GET /api/v1/public/emergency/:token
  validate token shape (cheap reject) → Redis cache (60 s) → DB lookup by unique public_token
  → map status to a public state (NOT_ACTIVATED | ACTIVE | LOST | STOLEN | UNAVAILABLE)
  → fire-and-forget scan log (HMAC-hashed IP, truncated UA)
```

No internal IDs, PIN data, owner data or history is ever returned.

## 9. Frontend architecture

- Vite + React 19 + React Router 7 (data routers not required), TanStack Query for server state,
  React Hook Form + Zod for forms, Tailwind 4 for styling.
- `src/lib/api.ts` — typed fetch client that unwraps the response envelope and throws `ApiError`
  with the server error code.
- Admin auth: access token in memory, refresh via httpOnly cookie on load and on 401 (single-flight).
- UI design language: monochrome "automotive/safety" system — black primary pill buttons, white
  canvas, 16 px cards, Inter, sentence-case bold headlines. Semantic red is reserved for critical
  states (stolen, recalled, errors) only. The emergency page uses a distinct, high-contrast,
  large-target layout.

## 10. Scaling path

- Stateless API → horizontal scale behind a load balancer; Redis for shared rate limits/caches.
- Batch generation can move to a worker process consuming a Redis queue without schema changes.
- Public emergency reads are cacheable at the edge (Cloudflare) with short TTL + purge on change.
- `helmet_scans` is append-only; partition by month when volume requires.
