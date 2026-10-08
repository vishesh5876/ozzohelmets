# Helmet Emergency Identity & Product Authentication Platform

Every physical helmet gets a unique, cryptographically generated identity — internal UUID,
human-readable Helmet ID (`HM-A8F3-KL92`), ≥128-bit QR token, Code128 barcode, one-time
activation PIN, serial number — bound to a model/SKU and a manufacturing batch. Customers activate
and own helmets; first responders scan the QR code to see only what the owner chose to share.

**Status: P1–P6 complete** — foundation + manufacturing, customer activation (QR + one-time PIN
→ email + password account) + emergency profile, ownership + lifecycle, warranty + product
authenticity, customer experience + admin support + security hardening, and analytics + QR abuse
detection (with a scheduled worker process). Three surfaces only: Admin, Customer, public QR. See
[`docs/PHASES.md`](docs/PHASES.md).

```
apps/
  api/      NestJS 11 + Prisma 6 (PostgreSQL) + Redis — modular monolith, /api/v1, Swagger
            + worker entrypoint (dist/worker.js: aggregation, risk evaluation, retention)
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

1. Admin: export the batch CSV (gives the activation PIN) and **Mark printed**. No inventory or
   sale step is needed — the helmet ships with its QR + PIN and can be bought anywhere
   ([ADR-001](docs/ADR-001-no-retail-inventory.md)).
2. Open the helmet's QR URL on a phone → _Ready to activate_ → **Activate helmet** → enter the PIN
   → enter your **email** → create a password → save the recovery code (shown once) → the helmet
   is yours (status ACTIVATED).
3. Onboarding: emergency details → contacts → choose what's public → review → **Turn on** →
   status ACTIVE.
4. Scan the QR anonymously: only the information you switched on is shown, with call buttons.
   Change privacy or turn the profile off and the next scan reflects it.

No camera? `/activate` → "Helmet ID" (checksum-validated) → PIN → email + password.
Sign in later with **email + password** (your Customer ID or an owned Helmet ID also work); forgot
it? `/recover` with your email (or ID) + recovery code — no mailbox access needed. Signed-in owners
add more helmets from **Add helmet** (PIN only, no new account). Change the account email from
**Account** (password + confirmation; no OTP).

## Phase 3 walkthrough (ownership & lifecycle)

1. **My helmets** groups helmets into Active / Needs attention / Retired; each helmet shows only
   the actions valid for its state, and emergency info is switched on **per helmet**.
2. **Transfer**: helmet → Transfer → confirm password → one-time code `TR-XXXX-XXXX-XXXX`
   (30 min, shown once). The recipient opens **/claim**, enters Helmet ID + code and signs in or
   creates an account (email + password) (recovery code shown once). The previous owner's emergency data disappears
   from the QR page immediately; the new owner's appears only after they enable it.
3. **Lost / found, stolen / recovered, damaged, retire**: confirmation pages (password for stolen,
   recovered and retire; typed Helmet ID to retire). The QR page shows a safe message without
   personal data; found/recovered return to the previous safe state.
4. **Admin helmet page**: ownership periods, transfers, replacement links and support actions
   (restore, forced deactivation, ownership revocation) behind dedicated permissions.

## Phase 4 walkthrough (warranty & product authenticity)

1. **Customer ID**: every account has a permanent `CU-XXXX-XXXX` shown on the Account page. Sign
   in (and recover) with a Helmet ID **or** the Customer ID — so a customer who no longer owns a
   helmet can still sign in.
2. **Warranty**: helmet → Register warranty → purchase date (+ optional channel, seller, invoice)
   → review → coverage computed on the server from the model's term. Optionally upload a private
   proof of purchase (JPEG/PNG/WebP/PDF ≤ 10 MB). The warranty stays with the helmet after a
   transfer; the new owner sees the status but not the previous owner's details or document.
3. **Verify**: `/verify/<token>` (linked from the QR page) says "Product identity verified" with
   model, batch, lifecycle and warranty status — and explains that a QR match confirms the
   registered identity, not the physical helmet. Unknown codes: "We could not verify this Helmet
   ID." Anyone can **report a problem** from there.
4. **Admin**: Warranties (search, filters, detail with history, corrections with a reason,
   void with password / restore, audited proof download) and Product reports (review statuses).
5. **Emergency rule**: damaged and recalled helmets keep already-shared emergency information with
   a warning; lost, stolen, replaced and retired helmets show none.

## Phase 5 walkthrough (customer experience, support, security)

1. **Dashboard**: safety check (no emergency contact, sharing off on a helmet, lost/stolen/damaged,
   recovery code not confirmed, warranty not registered…), profile completion %, security status,
   recent account activity and quick actions.
2. **Account**: account email, Customer ID, signed-in devices (sign out one, others, everywhere),
   change password, recovery code status + rotation, activity, **Download your data** (JSON) and
   **Request account deletion** (cancellable; reviewed by support, nothing erased automatically).
3. **Admin → Customers**: search by Customer ID, Helmet ID, email or name; the support view shows
   operational data only (never medical details). Suspend / lock / restore / sign out all sessions.
   Suspension doesn't hide a rider's emergency information.
4. **SUPER_ADMIN last resort**: Account Recovery Grant (admin password + reason + typed Customer ID)
   → one-time `AR-…` credential handed over by phone → customer resets at `/recover` → all sessions
   revoked, new recovery code shown once.
5. **Admin → Privacy requests**, operations dashboard, helmet support summary, filterable audit log
   and product-report triage.
6. **Public page**: emergency information first, large call buttons, "Provided by helmet owner",
   copy / print the approved information; repeated unknown-token lookups are rate-limited while
   real scans keep working.

## Phase 6 walkthrough (analytics & QR abuse detection)

1. Run the worker next to the API: `pnpm --filter @helmet/api worker` (or `--once all` for a
   single pass). It builds daily aggregates, evaluates review signals and applies retention.
2. **Admin → Analytics**: Overview (activation, emergency sharing, warranty and proof rates,
   incomplete profiles, daily charts), QR scans (today / 7 d / 30 d, top helmets, unknown-code
   requests), Helmet activity (helmets with review signals) and Risk alerts.
3. **Helmet analytics page**: 30-day scan chart, signals with observed value vs threshold, alerts
   (acknowledge / investigate / assign / resolve or dismiss with a reason), product reports and
   the admin-only **QR integrity** marker (normal / under review / compromised).
4. **Customer helmet page**: a neutral "Your helmet QR was accessed N times in the last 30 days."
5. Emergency pages are never disabled by analytics. Suspicious scan activity does **not** prove a
   physical helmet is counterfeit — everything is "review recommended".

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
- **Customer auth = email + password** (email bound at first activation, unique, unverified; PIN is the possession proof), Argon2id + pepper, offline recovery code, rotating refresh tokens, escalating lockouts, no OTP — [CUSTOMER-AUTH](docs/CUSTOMER-AUTH.md)
- **Atomic, row-locked activation** with progressive PIN lockouts — [ACTIVATION](docs/ACTIVATION.md)
- **Encrypted emergency profile** and allow-list public sanitizer (hidden fields omitted) — [EMERGENCY-PROFILE](docs/EMERGENCY-PROFILE.md)
- **Ownership periods** with one ACTIVE owner enforced in the database; **atomic transfers** with
  single-use HMAC'd codes and recent-auth — [OWNERSHIP](docs/OWNERSHIP.md), [TRANSFER](docs/TRANSFER.md)
- **Explicit owner lifecycle actions** through one policy; ACTIVE (and already-sharing DAMAGED /
  RECALLED, with a warning) helmets expose data — [HELMET-LIFECYCLE](docs/HELMET-LIFECYCLE.md),
  [REPLACEMENT](docs/REPLACEMENT.md)
- **Permanent Customer ID** `CU-XXXX-XXXX` (checksummed, not a secret) as an alternative sign-in
  identifier — [CUSTOMER-AUTH](docs/CUSTOMER-AUTH.md)
- **Per-helmet warranty**, server-computed dates, derived expiry, private content-validated proof
  of purchase, transfer inheritance without the previous owner's details — [WARRANTY](docs/WARRANTY.md)
- **Customer support without medical access**, immediate session revocation, SUPER_ADMIN-only
  recovery grants, privacy requests — [CUSTOMER-SUPPORT](docs/CUSTOMER-SUPPORT.md),
  [ACCOUNT-RECOVERY](docs/ACCOUNT-RECOVERY.md), [PRIVACY-REQUESTS](docs/PRIVACY-REQUESTS.md),
  [RBAC-MATRIX](docs/RBAC-MATRIX.md), [SECURITY-HARDENING](docs/SECURITY-HARDENING.md)
- **No retail/distributor/inventory model** by design — [ADR-001](docs/ADR-001-no-retail-inventory.md)
- **Product verification** that never claims more than "registered identity verified"; anonymous
  rate-limited product reports — [PRODUCT-AUTHENTICITY](docs/PRODUCT-AUTHENTICITY.md)
- **Analytics from daily aggregates** built by an idempotent, advisory-locked **worker**;
  **deterministic, explainable risk signals** (no ML) that never change lifecycle status or
  emergency access; enumeration and valid-token scraping detection without storing tokens or IPs —
  [ANALYTICS](docs/ANALYTICS.md), [RISK-ENGINE](docs/RISK-ENGINE.md),
  [QR-ABUSE-DETECTION](docs/QR-ABUSE-DETECTION.md), [WORKER](docs/WORKER.md),
  [DATA-RETENTION](docs/DATA-RETENTION.md)

## Flagged for product decisions

Open items are listed in [`docs/PHASE-6.md`](docs/PHASE-6.md#open-decisions) (risk thresholds,
retention period, owner notifications, QR replacement process),
[`docs/PHASE-4.md`](docs/PHASE-4.md#business-decisions-still-open)
(replacement warranty policy, warranty start date, proof retention, report triage),
[`docs/PHASE-3.md`](docs/PHASE-3.md#business-decisions-still-open)
("if found" contact, revoked helmet re-assignment — the other two were decided in Phase 4), [`docs/PHASE-2.md`](docs/PHASE-2.md#business-decisions-still-open)
(emergency number per market) and
[`docs/PHASE-1.md`](docs/PHASE-1.md#flagged-business-decisions-need-product-confirmation)
(MANUFACTURING PIN export, serial format, final QR domain printed on labels).

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Phases](docs/PHASES.md) · [Phase 1](docs/PHASE-1.md) · [Phase 2](docs/PHASE-2.md) · [Phase 3](docs/PHASE-3.md) · [Phase 4](docs/PHASE-4.md) · [Phase 5](docs/PHASE-5.md) · [Phase 6](docs/PHASE-6.md) ·
[Analytics](docs/ANALYTICS.md) · [Risk engine](docs/RISK-ENGINE.md) · [QR abuse detection](docs/QR-ABUSE-DETECTION.md) · [Worker](docs/WORKER.md) · [Data retention](docs/DATA-RETENTION.md) ·
[Customer support](docs/CUSTOMER-SUPPORT.md) · [Account recovery](docs/ACCOUNT-RECOVERY.md) · [Privacy requests](docs/PRIVACY-REQUESTS.md) · [RBAC matrix](docs/RBAC-MATRIX.md) · [Security hardening](docs/SECURITY-HARDENING.md) · [ADR-001](docs/ADR-001-no-retail-inventory.md) ·
[Ownership](docs/OWNERSHIP.md) · [Transfer](docs/TRANSFER.md) · [Replacement](docs/REPLACEMENT.md) ·
[Customer auth](docs/CUSTOMER-AUTH.md) · [Warranty](docs/WARRANTY.md) · [Product authenticity](docs/PRODUCT-AUTHENTICITY.md) · [Activation](docs/ACTIVATION.md) · [Emergency profile](docs/EMERGENCY-PROFILE.md) ·
[Database](docs/DATABASE.md) · [Security](docs/SECURITY.md) · [API](docs/API.md) ·
[Helmet lifecycle](docs/HELMET-LIFECYCLE.md) · [Development](docs/DEVELOPMENT.md) ·
[Deployment](docs/DEPLOYMENT.md)
