# Database

PostgreSQL 16 via Prisma 6. Schema: `apps/api/prisma/schema.prisma`; migrations:
`apps/api/prisma/migrations/` (committed, applied with `prisma migrate deploy`; `db push` is
never used).

## Conventions

- **Primary keys:** UUIDv7 (`@default(uuid(7)) @db.Uuid`) — time-ordered for index locality,
  never exposed in public URLs. The spec's separate `uuid` column is folded into `id`
  (`helmets.id` _is_ the internal helmet UUID).
- `created_at` / `updated_at` (`timestamptz(3)`) on every mutable table; append-only tables
  (`audit_logs`, `helmet_scans`, `helmet_status_history`) have `created_at` only.
- snake_case tables/columns (`@@map` / `@map`), camelCase in TypeScript.
- Every public identifier has a `UNIQUE` constraint.

## Tables (Phase 1)

| Table                       | Purpose                                                                                                                                  | Key constraints / indexes                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_users`               | Staff accounts (separate from customers)                                                                                                 | unique `email`                                                                                                                                        |
| `admin_refresh_tokens`      | Hashed rotating refresh tokens, `family_id`, `replaced_by`                                                                               | unique `token_hash`; idx `admin_id`, `family_id`                                                                                                      |
| `helmet_models`             | Models / SKUs                                                                                                                            | unique `sku`; idx `status`                                                                                                                            |
| `helmet_batches`            | Manufacturing batches + generation progress (`generated_count`, `generation_status`, `print_status`)                                     | unique `batch_code`; idx model, status, created_at; CHECK `quantity > 0`, `0 ≤ generated_count ≤ quantity`                                            |
| `helmets`                   | One row per physical helmet                                                                                                              | unique `helmet_code`, `public_token`, `serial_number`; idx `status`, `batch_id`, `helmet_model_id`, `created_at`; CHECK pin used ⇒ activated_at       |
| `helmet_activation_secrets` | Temporary AES-GCM PIN escrow (PK = helmet_id)                                                                                            | deleted on print / activation                                                                                                                         |
| `helmet_status_history`     | Every lifecycle change with actor + reason                                                                                               | idx (`helmet_id`, `created_at`)                                                                                                                       |
| `helmet_scans`              | QR scan log (hashed IP, UA, country, type)                                                                                               | idx (`helmet_id`, `scanned_at`), `scanned_at`                                                                                                         |
| `audit_logs`                | Append-only audit trail                                                                                                                  | idx (admin, created), (user, created), (entity_type, entity_id), action, created_at                                                                   |
| `users`                     | Customers: Customer ID, account email (sign-in identifier, unverified), Argon2id password + recovery-code hashes, optional mobile        | partial unique `email_normalized` among non-DELETED accounts; `mobile` intentionally **not** unique                                                   |
| `helmet_ownerships`         | Ownership **periods** (acquired via activation/transfer, ended by transfer/revocation), never overwritten                                | partial unique index: one `ACTIVE` row per helmet; CHECK `ACTIVE ⇔ ended_at IS NULL`; idx (`helmet_id`, `activated_at`), (`user_id`, `status`)        |
| `helmet_transfers`          | Transfer offers; HMAC of the code only; `PENDING/CLAIMED/CANCELLED/EXPIRED` (expiry computed)                                            | partial unique index: one `PENDING` per helmet; CHECK claim consistency, not-to-self; idx (`helmet_id`, `created_at`)                                 |
| `helmet_replacements`       | Original ↔ replacement helmet links                                                                                                      | unique `original_helmet_id`, unique `replacement_helmet_id`; CHECK distinct                                                                           |
| `helmet_emergency_settings` | Per-(helmet, user) switch: does this helmet expose this owner's profile                                                                  | unique (`helmet_id`, `user_id`)                                                                                                                       |
| `helmet_warranties`         | Phase 4: one warranty per helmet (dates, stored status, source, registrant, private purchase details, proof key, void, replacement link) | unique `helmet_id`, unique `replacement_of_warranty_id`; CHECK dates ordered, void consistent, proof fields all-or-none; idx status/end date, invoice |
| `warranty_history`          | Phase 4: append-only warranty events with actor, reason code, note, changed fields                                                       | idx (`warranty_id`, `created_at`)                                                                                                                     |
| `product_reports`           | Phase 4: anonymous public product reports (helmet link or raw token, reason, sanitized text, review status)                              | idx (`status`, `created_at`), `helmet_id`                                                                                                             |

Migrations: `20261003082113_init` (Phase 1) `20261003093118_phase2_customer_activation_profile` and
`20261003144957_phase2_password_auth_recovery` (Phase 2), `20261003162224_phase3_ownership_lifecycle` (Phase 3:
ownership period columns, `helmets.previous_operational_status`, `helmet_status_history.reason_code`,
transfers, replacements, per-helmet emergency settings + backfill), `20261003173121_phase4_customer_id`
(Phase 4: `users.customer_code` — PL/pgSQL backfill with checksum + uniqueness, then NOT NULL,
unique index, format CHECK; the helper function is dropped afterwards) and
`20261003173435_phase4_warranty_authenticity` (model warranty columns with CHECK 0–240, warranty
enums, `helmet_warranties`, `warranty_history`, `product_reports`, CHECKs; the `VERIFY` scan type already existed since Phase 1) and
`20261004090000_customer_email_signin` (`users.email_normalized` + email backfill + partial unique
index `users_email_normalized_live_key`, see below). Hand-written SQL in the init migration: `helmet_batch_code_seq` (batch code numbering), the
partial unique ownership index and CHECK constraints.

### Customer email migration (`20261004090000_customer_email_signin`)

The Phase 2 migration dropped `users_email_key`; it is **not** edited. The new migration:

1. adds `email_normalized`;
2. canonicalises stored emails like the app does (trim, empty → NULL, lower-case the domain);
3. backfills `email_normalized = lower(email)` for well-formed addresses only;
4. **duplicates among non-deleted accounts are never merged**: the oldest account
   (`created_at`, `id`) keeps email sign-in; each other account keeps its raw `email` but gets
   `email_normalized = NULL` and a `RAISE NOTICE` naming its Customer ID. Those accounts still
   sign in with their Customer ID / Helmet ID and can set a new email from Account;
5. creates the partial unique index.

Find accounts that need support follow-up after deploy:

```sql
SELECT customer_code, email FROM users
WHERE email IS NOT NULL AND email_normalized IS NULL AND status <> 'DELETED';
```

### Phase 5 migration (`20261005090000_phase5_support_privacy_security`)

| Table / change                                                              | Purpose                                                                         | Notable constraints                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `UserStatus` + `LOCKED`                                                     | admin security lock                                                             | —                                                                                                              |
| `users.status_changed_at`, `status_reason`, `recovery_code_acknowledged_at` | support notes, recovery-code acknowledgement (backfilled for existing accounts) | idx (`status`, `created_at`)                                                                                   |
| `customer_security_events`                                                  | customer-facing security activity (no raw IP, device summary)                   | idx (`user_id`, `created_at`), (`type`, `created_at`), `created_at`; retention `SECURITY_EVENT_RETENTION_DAYS` |
| `account_recovery_grants`                                                   | SUPER_ADMIN last-resort recovery (Argon2id hash only)                           | partial unique: one open grant per user; CHECK `expires_at > created_at`                                       |
| `account_deletion_requests`                                                 | privacy requests                                                                | partial unique: one `REQUESTED/APPROVED` per user; idx (`status`, `requested_at`)                              |
| `product_reports.priority`, `assigned_admin_id` + `product_report_events`   | report triage                                                                   | idx (`assigned_admin_id`, `status`), (`report_id`, `created_at`)                                               |
| `pg_trgm` + GIN indexes on `lower(email_normalized)`, `lower(name)`         | admin partial search                                                            | expression indexes (kept out of Prisma's diff)                                                                 |

### Phase 6 migration (`20261006090000_phase6_analytics_risk`)

- `helmet_scans` + `device_category`, `cache_hit`, `synthetic` (new rows store a UA summary).
- `helmets` + `qr_integrity_status` (`NORMAL` default), `qr_integrity_note`, `qr_integrity_changed_at`.
- New: `helmet_scan_daily` (unique helmet+date), `platform_daily_stats` (PK date),
  `helmet_risk_assessments` (PK helmet, score CHECK 0–100), `helmet_risk_signals`,
  `risk_alerts`, `worker_job_runs`.
- Hand-written: partial unique `helmet_risk_signals(helmet_id, type) WHERE status='ACTIVE'`;
  partial unique `risk_alerts(dedup_key) WHERE status IN ('OPEN','ACKNOWLEDGED','INVESTIGATING')`;
  CHECK `risk_alerts_subject` (helmet or source or platform type). These are outside Prisma's
  model, so `prisma migrate diff` reports no drift.
- Additive only; existing rows keep their values. See [ANALYTICS](ANALYTICS.md) and
  [DATA-RETENTION](DATA-RETENTION.md).

### Phase 7 migration (`20261010090000_phase7_worker_heartbeat`)

- New: `worker_heartbeats` (PK `worker_id` varchar(120), `hostname`, `version`, `started_at`,
  `last_beat_at` + index). Written by the worker every 30 s, pruned after 7 days.
- Additive only. Verified on a fresh database and on an upgraded Phase 6 database (row counts
  unchanged, drift check clean).
- Production applies migrations only with `prisma migrate deploy` (one-off step in
  `scripts/deploy-vps.sh`). Never `migrate reset` or `db push`. Backups and restores:
  [DISASTER-RECOVERY](DISASTER-RECOVERY.md).

## Not modelled (by decision)

Retailers, distributors, partner users, stock locations, inventory ledgers, transfers/manifests
and dealer sales are intentionally absent ([ADR-001](ADR-001-no-retail-inventory.md)).

## Planned (later phases)

- **Later:** warranty claims / service handling on the warranty record; erasure/anonymisation
  for completed deletion requests once retention rules are set.
- **Scale:** partition `helmet_scans` (evaluated in Phase 6 — not yet justified; plan and
  threshold in [DATA-RETENTION](DATA-RETENTION.md)) and `audit_logs` by month.

## Bulk generation

Chunks of `BATCH_GENERATION_CHUNK_SIZE` (default 500) are inserted per transaction with
`createMany` (helmets, escrow, history) plus an optimistic `generated_count` advance
(`WHERE generated_count = <offset>`), so a crash leaves a consistent, resumable batch and two
workers can never double-generate. IDs are generated client-side (UUIDv7) to link rows without
round-trips. Measured locally: ~1,200 helmets in ~14 s (dominated by Argon2 PIN hashing).

## Workflow

```bash
pnpm prisma:migrate --name <change>      # dev: create + apply a migration (prisma migrate dev)
pnpm prisma                              # apply committed migrations + seed
pnpm --filter @helmet/api prisma:migrate:deploy   # CI / production
```

The Phase 2 migration adds hand-written partial unique indexes (default profile per user, active
contact priority), CHECK constraints (enabled profile requires a name, contact priority range,
non-negative activation attempts). OTPs are never stored in PostgreSQL (Redis only).

### Applying to an external database

```bash
DATABASE_URL="postgresql://<user>:<password>@<host>:5432/<db>?schema=public&sslmode=require" \
  pnpm --filter @helmet/api prisma:migrate:deploy
```

`migrate deploy` only applies committed migrations (non-destructive). Never run the dev seed
against a shared or production database.
