# Delivery phases

Each phase ends with lint, typecheck, tests and build passing, docs updated, and a demoable flow.

## Phase 1 — Foundation + manufacturing _(current)_

Monorepo, NestJS API, PostgreSQL/Prisma migrations, Redis, Docker dev setup, env validation,
admin authentication (JWT + rotating refresh), RBAC foundation, helmet models, manufacturing
batches, secure identity generation (Helmet ID, QR token, activation PIN, serial), bulk batch
generation, QR + Code128 rendering, helmet listing/filtering, basic manufacturing CSV export,
audit log foundation, Swagger, basic public QR resolution ("not yet activated"), admin + portal
base apps, tests for identifier generation. Detailed checklist: [`PHASE-1.md`](./PHASE-1.md).

**Milestone:** login → create model → create batch → generate N helmets → view/search → export CSV
→ open QR URL → "This helmet has not yet been activated."

## Phase 2 — Customer identity, activation & emergency profile _(complete — see [`PHASE-2.md`](./PHASE-2.md))_

- Customer auth: owned Helmet ID + password (Argon2id + pepper), offline recovery code, escalating
  lockouts. No OTP/SMS (removed by product decision).
- Customer JWT + rotating refresh tokens (reuse detection), logout/revocation.
- Activation flow (helmetCode/QR + PIN → password) in one PostgreSQL transaction with
  `SELECT … FOR UPDATE` on the helmet row; PIN escrow purge on success; audit.
- Emergency profile with AES-256-GCM field encryption, emergency contacts, visibility settings
  (all default **off** except none), photo upload abstraction (S3-compatible later).
- Public emergency page full rendering, honoring visibility; Redis cache with invalidation.
- Customer portal screens: login, recovery, dashboard, my helmets, activate, helmet details,
  emergency profile, contacts, privacy controls, account.
- Re-evaluate SSR/edge-rendered emergency page for minimal JS.
- Tests: activation, double-activation race, ownership authorization, visibility filtering,
  login/recovery/PIN lockouts.

## Phase 3 — Ownership lifecycle

- Owner-initiated LOST / STOLEN / found; public safe-status messaging.
- Ownership transfer: 6-digit code in Redis (30 min TTL, attempt-limited), new owner claims with the code,
  ownership history, previous owner's emergency data never carried over, cache purge.
- Admin support tools: helmet lookup, ownership history, deactivate/replace, PIN re-issue for
  unactivated helmets whose escrow was purged.

## Phase 4 — Warranty & printing

- Warranty registration (purchaseDate, invoiceNumber, dealerId, warranty window/status).
- Label PDFs: QR labels, barcode labels, combined print sheets (configurable label stock).
- Batch print workflow (mark printed → escrow purge), reprint controls.

## Phase 5 — Dealers & distributors

- Dealer/distributor organisations and users, inventory movement (IN_INVENTORY → SOLD via barcode
  scan), dealer-assisted registration, regional reporting.

## Phase 6 — Analytics & anti-counterfeit

- Scan analytics dashboards, activation funnel, regional views.
- Clone detection signals over `helmet_scans`: scan velocity, impossible travel, device fan-out,
  cross-region scans; alerting and admin review queue.
- Product authenticity verification page.

## Phase 7 — Production hardening & AWS

- AWS infrastructure (IaC): ECS/Fargate or EKS, RDS PostgreSQL, ElastiCache Redis, S3, CloudFront/
  Cloudflare, KMS-backed keys (envelope encryption for medical data and PIN escrow), Secrets Manager.
- Observability (OpenTelemetry, metrics, alerting), backups/PITR, DR runbooks, pen test, load tests.
