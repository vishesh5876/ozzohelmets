# Helmet Emergency Identity & Product Authentication Platform

Every physical helmet gets a unique, cryptographically generated identity — internal UUID,
human-readable Helmet ID (`HM-A8F3-KL92`), ≥128-bit QR token, Code128 barcode, one-time
activation PIN, serial number — bound to a model/SKU and a manufacturing batch. Customers activate
and own helmets; first responders scan the QR code to see only what the owner chose to share.

**Status: Phase 2 complete** — foundation + manufacturing (Phase 1) and customer authentication,
helmet activation and emergency profiles (Phase 2). See [`docs/PHASES.md`](docs/PHASES.md).

```
apps/
  api/      NestJS 11 + Prisma 6 (PostgreSQL) + Redis — modular monolith, /api/v1, Swagger
  admin/    React 19 + Vite admin portal (manufacturing, helmets, audit, admin users)
  portal/   React 19 + Vite customer portal + standalone lightweight emergency page (/e/:token)
packages/
  types/    shared enums, permissions, lifecycle rules, identifier formats, API contracts
  ui/       shared React primitives + Tailwind 4 design tokens
  api-client/ typed fetch client (envelope, errors, single-flight refresh) for both SPAs
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

## Phase 2 walkthrough (customer)

1. Admin: export the batch CSV (gives the activation PIN), **Mark printed**, then on the helmet page
   move it **In inventory → Sold** (customers can only activate SOLD helmets by default).
2. Open the helmet's QR URL on a phone → **Activate helmet** → enter the PIN → create a password →
   save the recovery code (shown once) → the helmet is yours (status ACTIVATED).
3. Onboarding: emergency details → contacts → choose what's public → review → **Turn on** →
   status ACTIVE.
4. Scan the QR anonymously: only the information you switched on is shown, with call buttons.
   Change privacy or turn the profile off and the next scan reflects it.

No camera? `/activate` → "Helmet ID" (checksum-validated) → PIN → password.
Sign in later with **any Helmet ID you own + your password**; forgot it? `/recover` with a Helmet ID +
recovery code. Signed-in owners add more helmets from **Add helmet** (PIN only, no new account).

## Quality gates

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e            # API integration tests against real PostgreSQL + Redis (helmet_platform_test)
pnpm test:e2e:browser    # Playwright journey (with `pnpm dev` running)
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
- **Customer auth = Helmet ID + password** (Argon2id + pepper), offline recovery code, rotating refresh tokens, escalating lockouts — [CUSTOMER-AUTH](docs/CUSTOMER-AUTH.md)
- **Atomic, row-locked activation** with progressive PIN lockouts — [ACTIVATION](docs/ACTIVATION.md)
- **Encrypted emergency profile** and allow-list public sanitizer (hidden fields omitted) — [EMERGENCY-PROFILE](docs/EMERGENCY-PROFILE.md)

## Flagged for product decisions

Open items are listed in [`docs/PHASE-2.md`](docs/PHASE-2.md#business-decisions-still-open)
(retail SOLD flow, lost/stolen behaviour, emergency number per market) and
[`docs/PHASE-1.md`](docs/PHASE-1.md#flagged-business-decisions-need-product-confirmation)
(MANUFACTURING PIN export, serial format, final QR domain printed on labels).

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Phases](docs/PHASES.md) · [Phase 1](docs/PHASE-1.md) · [Phase 2](docs/PHASE-2.md) ·
[Customer auth](docs/CUSTOMER-AUTH.md) · [Activation](docs/ACTIVATION.md) · [Emergency profile](docs/EMERGENCY-PROFILE.md) ·
[Database](docs/DATABASE.md) · [Security](docs/SECURITY.md) · [API](docs/API.md) ·
[Helmet lifecycle](docs/HELMET-LIFECYCLE.md) · [Development](docs/DEVELOPMENT.md) ·
[Deployment](docs/DEPLOYMENT.md)
