# Helmet Emergency Identity & Product Authentication Platform

Every physical helmet gets a unique, cryptographically generated identity — internal UUID,
human-readable Helmet ID (`HM-A8F3-KL92`), ≥128-bit QR token, Code128 barcode, one-time
activation PIN, serial number — bound to a model/SKU and a manufacturing batch. Customers activate
and own helmets; first responders scan the QR code to see only what the owner chose to share.

**Status: Phase 1 (foundation + manufacturing) complete.** See [`docs/PHASES.md`](docs/PHASES.md).

```
apps/
  api/      NestJS 11 + Prisma 6 (PostgreSQL) + Redis — modular monolith, /api/v1, Swagger
  admin/    React 19 + Vite admin portal (manufacturing, helmets, audit, admin users)
  portal/   React 19 + Vite customer portal + public emergency page (/e/:token)
packages/
  types/    shared enums, permissions, lifecycle rules, identifier formats, API contracts
  ui/       shared React primitives + Tailwind 4 design tokens
  tsconfig/ eslint-config/
docs/       architecture, database, security, API, lifecycle, development, deployment
```

## Quick start

Requirements: Node ≥ 22, pnpm 10 (`corepack enable`), Docker.

```bash
cp .env.example .env     # development-only placeholder values
pnpm install
docker compose up -d     # PostgreSQL :5432 + Redis :6379
pnpm prisma              # apply migrations + seed (SUPER_ADMIN, sample models, batch, helmets)
pnpm dev                 # API :4000 · Admin :3000 · Portal :3001
```

|                    | URL                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Admin portal       | http://localhost:3000 — `superadmin@example.com` / `ChangeMe-Dev-Only-123!` (from `SEED_*` in `.env`) |
| Customer portal    | http://localhost:3001                                                                                 |
| API docs (Swagger) | http://localhost:4000/api/docs                                                                        |
| Health             | http://localhost:4000/api/v1/health                                                                   |

Ports, URLs and secrets are all controlled by `.env`. Full containerised stack:
`docker compose --profile full up -d --build`.

## Phase 1 walkthrough

1. Sign in to the admin portal.
2. **Helmet models → New model** (e.g. Roadster X1, `RX1-MATTE-BLK`).
3. **Generate helmets** (new batch): pick the model, date, quantity (e.g. 100), keep
   "Generate immediately" checked. A `BAT-YYYY-NNNNN` code is assigned and progress is live.
4. Browse **Helmets**: search by Helmet ID or serial, filter by status/batch/model; open one to
   see its QR code, barcode (PNG/SVG downloads), public URL and status history.
5. **Export CSV** on the batch (`helmetCode, serialNumber, model, batchCode, qrUrl,
activationPin`) — SUPER_ADMIN/ADMIN only, audited.
6. Open a `qrUrl` → _"This helmet has not yet been activated."_
7. **Mark printed** once labels are on the helmets: status → PRINTED, escrowed PINs destroyed.

## Quality gates

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e            # API integration tests against real PostgreSQL + Redis (helmet_platform_test)
```

## Key decisions (details in docs)

- **Modular monolith** with service-shaped NestJS modules — [ARCHITECTURE](docs/ARCHITECTURE.md)
- **Helmet ID** `HM-XXXX-XXXY`: 7 CSPRNG symbols from an unambiguous 31-char alphabet + a mod-31
  weighted check symbol; **QR token** 22 base62 chars (~131 bits) — [SECURITY §2](docs/SECURITY.md)
- **Activation PINs** stored only as Argon2id + pepper; plaintext kept in a short-lived AES-256-GCM
  escrow solely for the label export, purged when the batch is marked printed — [SECURITY §3](docs/SECURITY.md)
- **Lifecycle** enforced by a domain service + shared transition table — [HELMET-LIFECYCLE](docs/HELMET-LIFECYCLE.md)
- **Admin auth**: Argon2id, 15-min JWT in memory, rotating hashed refresh tokens with reuse
  detection, backend RBAC — [SECURITY §4–5](docs/SECURITY.md)
- **Resumable, chunked, transactional batch generation** — [DATABASE](docs/DATABASE.md)

## Flagged for product decisions

Listed in [`docs/PHASE-1.md`](docs/PHASE-1.md#flagged-business-decisions-need-product-confirmation):
activatable statuses, ACTIVATED vs ACTIVE, whether MANUFACTURING may export PINs, serial number
format, escrow purge trigger, and the final QR domain (`PUBLIC_EMERGENCY_BASE_URL` is printed on
labels).

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Phases](docs/PHASES.md) · [Phase 1 checklist](docs/PHASE-1.md) ·
[Database](docs/DATABASE.md) · [Security](docs/SECURITY.md) · [API](docs/API.md) ·
[Helmet lifecycle](docs/HELMET-LIFECYCLE.md) · [Development](docs/DEVELOPMENT.md) ·
[Deployment](docs/DEPLOYMENT.md)
