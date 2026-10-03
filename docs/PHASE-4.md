# Phase 4 — Warranty & product authenticity

Status: **complete**. Legend: `[x]` done · `[ ]` pending

Details: [WARRANTY](WARRANTY.md) · [PRODUCT-AUTHENTICITY](PRODUCT-AUTHENTICITY.md) ·
[CUSTOMER-AUTH § Customer ID](CUSTOMER-AUTH.md#customer-id-phase-4) ·
[SECURITY §14](SECURITY.md#14-phase-4--customer-id-warranty-product-authenticity)

## Scope

Permanent Customer ID and Customer-ID sign-in; per-helmet warranty (policy, registration, proof of
purchase, transfer inheritance, replacement policy, admin corrections/void/restore); public product
verification and VERIFY telemetry; anonymous product reports with admin review; revised public
emergency rule for damaged/recalled helmets; recall-ready contracts.

Out of scope (later phases): dealers/distributors, warranty claims, service centres,
anti-counterfeit scoring, analytics dashboards, recall campaigns, AWS changes.

## Design decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Customer ID** `CU-` + 7 CSPRNG symbols + mod-31 check symbol (Helmet ID scheme). Stored in `users.customer_code` (unique, format CHECK, NOT NULL). Existing accounts backfilled in the migration by a temporary PL/pgSQL generator using `gen_random_uuid()` bytes with rejection sampling (no modulo bias) and a uniqueness check; the function is dropped afterwards. Not a secret. |
| 2   | **Sign-in/recovery accept `identifier`** (Helmet ID or Customer ID; legacy `helmetCode` still accepted). Same generic errors ("The ID or password is incorrect."), lockouts per identifier and per account.                                                                                                                                                                             |
| 3   | **Warranty is per helmet**: one `helmet_warranties` row (unique `helmet_id`). Stored status ACTIVE/VOID/REPLACED/CANCELLED; `NOT_REGISTERED` (no row) and `EXPIRED` (end date passed) are derived on read — no cron.                                                                                                                                                                    |
| 4   | **Coverage** = purchase date → purchase date + model months − 1 day, computed only in `WarrantyPolicyService`. Purchase date ≤ today (+1 day tolerance) and ≥ manufacturing date.                                                                                                                                                                                                       |
| 5   | **Model policy**: `warranty_enabled` (default true), `warranty_months` (default 24, 0–240). Changing it does not rewrite existing warranties.                                                                                                                                                                                                                                           |
| 6   | **Registration**: current owner only, in ACTIVATED/ACTIVE/LOST/STOLEN/DAMAGED/RECALLED; helmet+ownership row locks; same-date resubmission is idempotent, anything else conflicts.                                                                                                                                                                                                      |
| 7   | **Proof of purchase**: JPEG/PNG/WebP/PDF ≤ 10 MB, validated by content, images re-encoded, risky PDFs rejected, private storage, attachment-only downloads; admin access needs `warranty:document-view` and is audited.                                                                                                                                                                 |
| 8   | **Transfer inheritance**: the warranty stays; private purchase details and the document are visible only to the registrant while they own the helmet.                                                                                                                                                                                                                                   |
| 9   | **Replacement policy** `WARRANTY_REPLACEMENT_POLICY=INHERIT_END_DATE` (default): replacement coverage ends on the original end date; `NEW_TERM` alternative; per-replacement admin override. VOID/CANCELLED never inherited; invoice/proof never copied.                                                                                                                                |
| 10  | **Admin corrections** require a reason code; history stores date changes old → new and other fields by name only. Void requires `warranty:void` + recent password confirmation; restore reverses a void. No delete.                                                                                                                                                                     |
| 11  | **Verification** wording: "Product identity verified … confirms the registered identity, not the physical helmet itself." Unknown/malformed: "We could not verify this Helmet ID. Check the QR code or contact support." Never "counterfeit".                                                                                                                                           |
| 12  | **Product reports**: anonymous, 5/h per IP, sanitized, never public, OPEN → REVIEWING → RESOLVED / DISMISSED by `product-report:manage`.                                                                                                                                                                                                                                                |
| 13  | **Emergency rule**: DAMAGED and RECALLED keep already-shared approved info with a warning; LOST/STOLEN/REPLACED/DEACTIVATED hide everything (decides Phase 3 open item #2).                                                                                                                                                                                                             |
| 14  | **Recall-ready**: `recallWarning` on the verification DTO and `warning` on the emergency DTO; no recall-campaign entity yet.                                                                                                                                                                                                                                                            |
| 15  | **Permissions**: `warranty:view`, `warranty:manage`, `warranty:void`, `warranty:document-view`, `product-report:view`, `product-report:manage`. SUPER_ADMIN all; ADMIN all except document view; SUPPORT view/manage/document/reports (no void); MANUFACTURING and ANALYTICS_VIEWER none.                                                                                               |

## Checklist

### Backend

- [x] Migration `20261003173121_phase4_customer_id` (column, backfill, NOT NULL, unique, CHECK)
- [x] Migration `20261003173435_phase4_warranty_authenticity` (model policy, enums, warranty, history, reports, CHECKs)
- [x] Shared types: identifiers, enums, contracts, error codes, permissions
- [x] Customer ID generation on account creation; login/recovery by Customer ID; admin owner reference
- [x] `WarrantyPolicyService` + warranty service (register, proof, public summary, replacement)
- [x] Admin warranty service (list/search/filter, detail, correct, void, restore, audited proof)
- [x] Replacement integration (same transaction, override end date)
- [x] Public verification endpoint, cache + invalidation, VERIFY scans
- [x] Product reports (public + admin), rate limit, sanitization
- [x] DAMAGED/RECALLED public emergency rule with warnings
- [x] Audit events

### Frontend

- [x] Login/recovery/claim accept Helmet ID or Customer ID
- [x] Account page Customer ID card with copy
- [x] Warranty page (register → review → status, proof upload/replace/download/remove), helmet card + detail summary
- [x] Emergency page: damaged/recalled warnings with profile, verify link
- [x] Verification page with report form (emergency bundle, nginx `/verify/`)
- [x] Admin: warranty list/detail/correct/void/restore, product reports, model warranty fields, permission labels, Customer IDs

### Quality

- [x] Unit tests (Customer ID generator/parser, warranty policy, document processor, public states, enum sync)
- [x] Integration tests (Customer ID, warranty incl. concurrency + transfer + replacement, authenticity, reports, emergency rule)
- [x] Playwright 22-step journey + zero-helmet Customer ID sign-in
- [x] Docs

## Results

### Verification

| Check                                                               | Result                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm build` | pass                                                                                                                                                                                                                                                                                                                                   |
| API unit tests                                                      | 185 passed (26 suites; Phase 3: 163)                                                                                                                                                                                                                                                                                                   |
| API integration tests (PostgreSQL + Redis)                          | 128 passed (14 suites; Phase 3: 102) — incl. concurrent warranty registration, transfer privacy, replacement policy, Customer ID login/recovery/lockouts, verification leaks, report rate limit                                                                                                                                        |
| Playwright                                                          | 26/26 (Phase 2: 10, Phase 3: 8 — step 25 updated for the DAMAGED rule, Phase 4: 8 tests covering all 22 steps + zero-helmet Customer ID sign-in)                                                                                                                                                                                       |
| Docker                                                              | API, portal and admin images built; API container applied all 6 migrations on an empty database, passed health and served `/public/verify`, product reports, admin guards and Customer ID login; portal nginx serves `/verify/*` and `/e/*` from `emergency.html` and `/app/*` from the SPA; production mode still refuses dev secrets |
| Fresh migrations (Phase 1 → 4)                                      | `prisma migrate deploy` on an empty database: 6 applied, `migrate status` up to date, `migrate diff` vs schema: no drift                                                                                                                                                                                                               |
| Existing data (Phase 3 copy → 4)                                    | Copy of the Phase 3 dev database (25 users, 26 active ownerships): both Phase 4 migrations applied; 25/25 Customer IDs backfilled, all checksum-valid and unique, none NULL; ownerships, emergency settings (20, 12 enabled) and profiles (24) unchanged; models got `warranty_enabled = true`, 24 months; no drift                    |

### Migrations

`20261003173121_phase4_customer_id` and `20261003173435_phase4_warranty_authenticity`. Earlier
migrations untouched. Not yet applied to the external database — apply with
`prisma migrate deploy` (the backfill runs inside the migration).

## Business decisions still open

1. **Replacement warranty term**: default inherits the original end date; confirm vs. a new full
   term (`WARRANTY_REPLACEMENT_POLICY=NEW_TERM`).
2. **Coverage start**: purchase date (implemented) vs. activation date when no invoice is given.
3. **Late registration**: no deadline today; should registration close N days after purchase?
4. **Proof retention**: how long to keep documents after ownership ends or coverage expires
   (currently kept; removable by the registrant).
5. **Admin proof access**: ADMIN role excluded by default — confirm.
6. **Product-report follow-up**: who contacts reporters, and SLA; whether to show "this Helmet ID
   has been reported" anywhere (currently never public).
7. **Customer ID on printed material** (e.g. warranty card) — not done.

## Deferred (intentional)

- Warranty claims, service centres, dealer-registered warranties, recall campaigns.
- Clone-detection signals and dashboards over VERIFY/EMERGENCY scans.
- S3 storage provider for proofs (local provider behind the same interface).
- Malware scanning of uploaded PDFs (structural checks only today).
