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

| Table                       | Purpose                                                                                              | Key constraints / indexes                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin_users`               | Staff accounts (separate from customers)                                                             | unique `email`                                                                                                                                  |
| `admin_refresh_tokens`      | Hashed rotating refresh tokens, `family_id`, `replaced_by`                                           | unique `token_hash`; idx `admin_id`, `family_id`                                                                                                |
| `helmet_models`             | Models / SKUs                                                                                        | unique `sku`; idx `status`                                                                                                                      |
| `helmet_batches`            | Manufacturing batches + generation progress (`generated_count`, `generation_status`, `print_status`) | unique `batch_code`; idx model, status, created_at; CHECK `quantity > 0`, `0 ≤ generated_count ≤ quantity`                                      |
| `helmets`                   | One row per physical helmet                                                                          | unique `helmet_code`, `public_token`, `serial_number`; idx `status`, `batch_id`, `helmet_model_id`, `created_at`; CHECK pin used ⇒ activated_at |
| `helmet_activation_secrets` | Temporary AES-GCM PIN escrow (PK = helmet_id)                                                        | deleted on print / activation                                                                                                                   |
| `helmet_status_history`     | Every lifecycle change with actor + reason                                                           | idx (`helmet_id`, `created_at`)                                                                                                                 |
| `helmet_scans`              | QR scan log (hashed IP, UA, country, type)                                                           | idx (`helmet_id`, `scanned_at`), `scanned_at`                                                                                                   |
| `audit_logs`                | Append-only audit trail                                                                              | idx (admin, created), (user, created), (entity_type, entity_id), action, created_at                                                             |
| `users`                     | Customers (schema only; Phase 2)                                                                     | unique `email`, `mobile`                                                                                                                        |
| `helmet_ownerships`         | Ownership history, never overwritten                                                                 | partial unique index: one `ACTIVE` row per helmet                                                                                               |

Hand-written SQL in the init migration: `helmet_batch_code_seq` (batch code numbering), the
partial unique ownership index and CHECK constraints.

## Planned (later phases)

- **Phase 2:** `emergency_profiles` (sensitive columns stored as AES-256-GCM ciphertext text),
  `emergency_contacts`, `emergency_visibility` (all flags default `false`), `user_refresh_tokens`.
- **Phase 3:** `ownership_transfers` (or Redis-only codes) with audit.
- **Phase 4:** `warranties` (`helmet_id`, `purchase_date`, `dealer_id`, `invoice_number`,
  `warranty_start_date`, `warranty_end_date`, `warranty_status`).
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
