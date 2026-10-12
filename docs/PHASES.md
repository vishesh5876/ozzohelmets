# Delivery phases

Each phase ends with lint, typecheck, tests and build passing, docs updated, and a demoable flow.

The product has exactly three surfaces: **Admin**, **Customer** and the **public QR** pages. It
intentionally does not model retailers, distributors or inventory — physical possession is
proven with the helmet's one-time activation PIN ([ADR-001](./ADR-001-no-retail-inventory.md)).
A dealer/distributor/inventory phase was prototyped and **never merged**; it is not on the roadmap.

## P1 — Foundation + Manufacturing _(complete)_

Monorepo, NestJS API, PostgreSQL/Prisma migrations, Redis, Docker dev setup, env validation,
admin authentication (JWT + rotating refresh), RBAC foundation, helmet models, manufacturing
batches, secure identity generation (Helmet ID, QR token, activation PIN, serial), bulk batch
generation, QR + Code128 rendering, helmet listing/filtering, basic manufacturing CSV export,
audit log foundation, Swagger, basic public QR resolution ("not yet activated"), admin + portal
base apps, tests for identifier generation. Detailed checklist: [`PHASE-1.md`](./PHASE-1.md).

**Milestone:** login → create model → create batch → generate N helmets → view/search → export CSV
→ open QR URL → "This helmet has not yet been activated."

## P2 — Customer Activation + Emergency Profile _(complete — see [`PHASE-2.md`](./PHASE-2.md))_

- Customer auth: password (Argon2id + pepper), offline recovery code, escalating lockouts. No
  OTP/SMS/email verification (product decision).
- **Scope correction (2026-10-04):** the first activation binds an **account email** (unique,
  unverified, sign-in identifier only) — QR → PIN → email → password. Normal sign-in is email +
  password; Customer ID and owned Helmet ID still work. Activation is allowed from `PRINTED`,
  `IN_INVENTORY` and `SOLD`: no sale record is needed.
- Customer JWT + rotating refresh tokens (reuse detection), logout/revocation.
- Activation flow (helmetCode/QR + PIN → email + password) in one PostgreSQL transaction with
  `SELECT … FOR UPDATE` on the helmet row; PIN escrow purge on success; audit.
- Emergency profile with AES-256-GCM field encryption, emergency contacts, visibility settings
  (all default **off** except none), photo upload abstraction (S3-compatible later).
- Public emergency page full rendering, honoring visibility; Redis cache with invalidation.
- Customer portal screens: login, recovery, dashboard, my helmets, activate, helmet details,
  emergency profile, contacts, privacy controls, account.
- Re-evaluate SSR/edge-rendered emergency page for minimal JS.
- Tests: activation, double-activation race, ownership authorization, visibility filtering,
  login/recovery/PIN lockouts.

## P3 — Ownership + Helmet Lifecycle _(complete — see [`PHASE-3.md`](./PHASE-3.md))_

- Multiple helmets per account; per-helmet emergency exposure.
- Secure ownership transfer: recent password check, one-time `TR-` code (HMAC at rest, 30 min),
  atomic row-locked claim by existing or new customers, previous owner's data removed instantly.
- Owner LOST / found, STOLEN / recovered, DAMAGED, retirement (DEACTIVATED) with restore to the
  previous safe state; explicit, data-free public states.
- Replacement links between two separate helmet identities; ownership periods and owner timeline.
- Permission-gated support actions: history, cancel transfer, restore, forced deactivation,
  ownership revocation (SUPER_ADMIN), replacement linking.

## P4 — Warranty + Product Authenticity _(complete — see [`PHASE-4.md`](./PHASE-4.md))_

- Permanent Customer ID (`CU-XXXX-XXXX`) as a second sign-in/recovery identifier; customers with
  zero helmets can sign in.
- Per-helmet warranty registered by the customer (free-text seller name): model policy, server-computed coverage, derived expiry, idempotent
  registration, private proof of purchase, transfer inheritance, replacement policy, admin
  corrections / void / restore with history and audit.
- Public product verification (`/verify/:token`), VERIFY scan telemetry, anonymous product reports
  with admin review, recall-ready contract.
- Revised public emergency rule for DAMAGED / RECALLED helmets.

## P5 — Customer Experience + Admin Operations + Security Hardening _(complete — see [`PHASE-5.md`](./PHASE-5.md))_

- Customer: operational dashboard (health check, profile completion, security status, activity,
  quick actions), Account page (sessions with device summary, sign out one/others/everywhere,
  recovery-code status + rotation, activity, JSON data export, deletion request/cancel), contacts
  guidance, navigation: Dashboard, My helmets, Emergency profile, Emergency contacts, Privacy,
  Warranty, Account.
- Admin: customer search (Customer ID / Helmet ID / partial email or name) and support view (no
  medical data), suspend/lock/restore/force sign-out, SUPER_ADMIN mark-deleted and last-resort
  Account Recovery Grant, privacy requests, security events, operations dashboard, helmet support
  summary, audit filters/labels, product-report triage.
- Security: immediate session revocation, minimal device data, customer security events, adaptive
  public QR abuse controls, RBAC matrix + customer isolation tests, encryption/upload review.
- Moved to later phases: label PDFs and batch print workflow, warranty claims, emailed reset links.

## P6 — Analytics + QR Abuse / Copied-Code Detection _(complete — see [`PHASE-6.md`](./PHASE-6.md))_

- Daily helmet and platform aggregates built by a scheduled **worker** (same codebase, separate
  process, PostgreSQL advisory locks); dashboards read aggregates.
- Admin Analytics: overview, QR scans, helmet activity, risk alerts, helmet analytics page.
- Deterministic, explainable risk signals and scores (no ML), deduplicated alerts with a human
  workflow, admin-only QR integrity marker; token enumeration and valid-token scraping detection.
- Neutral customer scan summary; configurable retention (scan detail 180 days, aggregates kept).
- Not done by decision: impossible-travel / regional views (no precise location is collected),
  automatic customer notifications, automatic QR status changes, partitioning (evaluated, see
  [`DATA-RETENTION.md`](./DATA-RETENTION.md)).

## P7 — VPS Production Deployment + Monitoring + Backups + Launch Readiness _(complete — see [`PHASE-7.md`](./PHASE-7.md))_

- Single Linux VPS behind Cloudflare, Docker Compose (`docker-compose.prod.yml`): edge nginx (TLS,
  Cloudflare real IP, origin lock option, rate limits, headers), api, worker, admin, portal,
  postgres, redis; uploads on the local filesystem. **No AWS.**
- Health live/ready, Redis outage policy (public fail-open, auth fail-closed), Prometheus metrics,
  worker DB heartbeat + admin System status, Argon2 concurrency limiter, optional ClamAV,
  production config guards, admin bootstrap and key-rotation CLI.
- Backups (pg_dump + uploads, manifest, GFS, offsite hook), restore with confirmation, restore
  drills, deploy/rollback script, systemd timer, CI (no deployment).
- Load and failure tests, dependency audit, security review; VPS-DEPLOYMENT, DISASTER-RECOVERY,
  INCIDENT-RESPONSE, MONITORING, DATA-INVENTORY, LAUNCH-CHECKLIST and runbooks.
- Status: **READY WITH CONDITIONS**. An offsite backup with a tested restore, external uptime
  monitoring and the physical QR test are required before launch.

## P8 — Production acceptance + pilot launch + operational polish _(see [`PHASE-8.md`](./PHASE-8.md))_

- Customer: one guided activation and emergency setup with a progress indicator and a factual
  completion summary; dashboard led by emergency protection status; per-helmet sharing on cards
  and detail; consistent credential terminology; safer error copy; empty states.
- Public: emergency facts in priority order; call buttons show the number.
- Admin: Activation PIN state, batch workflow / export history / counts, batch filters, one-box
  helmet search, customer quick links and separated restrictive actions, internal-test alert
  dismissal; internal test model excluded from analytics. No new tables or migrations.
- Ops: `scripts/production-smoke.sh`, `scripts/ozzo-health-report.sh`,
  `scripts/pilot-metrics.sql`; RELEASE-CHECKLIST, CHANGELOG (v1.0.0), PILOT, support SOP,
  manufacturing SOP additions (test helmets, physical PIN options).

## P9 — Safety ID architecture + standalone emergency QR _(complete — see [`PHASE-9.md`](./PHASE-9.md))_

- The **Safety ID** (`SI-XXXX-XXXX`) owns the QR token, Activation PIN (+ escrow), owner,
  per-Safety-ID emergency sharing, scans and risk; a helmet keeps product identity, warranty
  and lifecycle and can be linked to one Safety ID. Standalone Safety IDs (stickers, cards) work
  without any helmet.
- Generation: standalone / helmet-linked Safety ID batches and "Generate a Safety ID for each
  helmet" (default on); CSV + print sheet; escrow purged on mark printed.
- Expand / migrate / switch migration with nothing dropped: tokens identical, unused PINs keep
  working, owners and sharing unchanged; verify, reconcile and public replay scripts.
- Person-focused emergency page; standalone verify message; activation, sharing, transfer
  (Transfer Code), analytics and risk per Safety ID; My Safety IDs; admin Safety IDs and Safety
  ID Batches; RBAC, audit, account export.
- Docs: [SAFETY-ID](./SAFETY-ID.md), [SAFETY-ID-MANUFACTURING](./SAFETY-ID-MANUFACTURING.md),
  [SAFETY-ID-MIGRATION](./SAFETY-ID-MIGRATION.md). Not deployed yet (high-risk deployment plan).
