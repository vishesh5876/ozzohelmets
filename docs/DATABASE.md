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
| `users`                     | Customers: Argon2id password + recovery-code hashes; optional unverified email/mobile                                                    | `email`, `mobile` intentionally **not** unique (never used to identify)                                                                               |
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
enums, `helmet_warranties`, `warranty_history`, `product_reports`, CHECKs; the `VERIFY` scan type already existed since Phase 1). Hand-written SQL in the init migration: `helmet_batch_code_seq` (batch code numbering), the
partial unique ownership index and CHECK constraints.

## Planned (later phases)

- **Phase 5:** warranty claims, dealer link on warranties (`purchase_channel = DEALER` today).
- **Phase 5:** `dealers`, `dealer_users`, inventory movements.
- **Scale:** partition `helmet_scans` and `audit_logs` by month.

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
