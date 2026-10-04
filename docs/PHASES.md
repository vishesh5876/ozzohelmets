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

## P5 — Customer Experience + Admin Operations + Security Hardening

- Customer: portal navigation (Dashboard, My helmets, Add helmet, Emergency profile, Emergency
  contacts, Warranty, Account), email change (password + confirmation, no OTP), accessibility and
  copy review, optional email reset links (architecture allows them; not built).
- Admin operations: label PDFs (QR/barcode labels, print sheets), batch print workflow and reprint
  controls, customer lookup for support, warranty claims / service handling on the Phase 4 record.
- Security hardening: dependency and secret scanning in CI, CSP review, session/device
  management polish, abuse rate-limit tuning.

## P6 — Analytics + QR Abuse / Anti-Copy Detection

- Scan analytics dashboards, activation funnel, regional views.
- Clone detection signals over `helmet_scans`: scan velocity, impossible travel, device fan-out,
  cross-region scans; alerting and admin review queue.
- Builds on the Phase 4 verification page, VERIFY scans and product reports; recall campaigns.

## P7 — Production Infrastructure + Monitoring + Launch Readiness

- AWS infrastructure (IaC): ECS/Fargate or EKS, RDS PostgreSQL, ElastiCache Redis, S3, CloudFront/
  Cloudflare, KMS-backed keys (envelope encryption for medical data and PIN escrow), Secrets Manager.
- Observability (OpenTelemetry, metrics, alerting), backups/PITR, DR runbooks, pen test, load tests,
  launch checklist.
