# Phase 9: Safety ID architecture and standalone Emergency QR

**The Safety ID is the emergency identity. A helmet is an optional linked product.**

Before Phase 9 the chain was Helmet → QR → Activation PIN → emergency profile. Phase 9 makes
the QR an **Emergency Safety ID** (`SI-XXXX-XXXX`) that owns the public token, the Activation
PIN, the current owner, emergency sharing, scans and QR risk. It can be linked to at most one
helmet, or to none (a free standalone sticker or card). Existing printed QR codes, URLs and
unused PINs keep working unchanged.

Detailed references: [SAFETY-ID](SAFETY-ID.md) (domain and rules) ·
[SAFETY-ID-PRINT](SAFETY-ID-PRINT.md) (final sticker, six-digit PIN, 48-up print, physical QA) ·
[SAFETY-ID-MIGRATION](SAFETY-ID-MIGRATION.md) (Phase 8 → 9 data migration and deployment) ·
[SAFETY-ID-MANUFACTURING](SAFETY-ID-MANUFACTURING.md) (generation, print, PIN escrow).

## 1. Baseline (start of phase)

Phase 8 head `412f873`: unit 303, integration 188 (19 suites), Playwright 55, all green; format,
lint, typecheck and build clean. Production runs the Phase 7 + PM2 code. Phase 8 had not been
deployed when Phase 9 started.

## 2. Domain model

```
Customer ── Emergency profile, contacts, visibility (account-wide, unchanged)
   ├── SafetyIdOwnership (one ACTIVE per Safety ID) ── Safety ID ── SafetyIdEmergencySetting
   │                                                      ├── public token, Activation PIN, escrow
   │                                                      ├── status, QR integrity, scans, risk
   │                                                      └── SafetyIdHelmetLink (0..1 current)
   └── HelmetOwnership (unchanged) ─────────────────────── Helmet (product, warranty, lifecycle)
```

| Table (new)                                            | Purpose                                                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `safety_ids`                                           | `safety_code` (unique), `public_token` (unique), `status`, PIN hash + attempts/lock, PIN used, QR integrity, batch, activated/deactivated |
| `safety_id_activation_secrets`                         | encrypted PIN escrow (AES-256-GCM, `PIN_ESCROW_KEYS`, AAD = Safety ID id); purged on "printed" or activation                              |
| `safety_id_batches`                                    | standalone or helmet-linked generation runs (`SID-YYYY-NNNNN`), durable progress                                                          |
| `safety_id_helmet_links`                               | link history; partial unique indexes: one current link per Safety ID and per helmet                                                       |
| `safety_id_ownerships`                                 | ownership history; partial unique: one ACTIVE owner per Safety ID; source ACTIVATION / TRANSFER / ADMIN_ASSIGNMENT / MIGRATION            |
| `safety_id_emergency_settings`                         | per-(Safety ID, owner) sharing switch, replaces the helmet-level switch                                                                   |
| `safety_id_transfers`                                  | Transfer Codes for standalone Safety IDs                                                                                                  |
| `safety_id_scan_daily`                                 | per-Safety-ID daily scan aggregates                                                                                                       |
| `safety_id_risk_assessments`, `safety_id_risk_signals` | risk state per Safety ID                                                                                                                  |

| Changed (additive only) | Change                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `helmet_scans`          | + `safety_id` (FK, indexed); `helmet_id` becomes nullable (standalone scans have no helmet)          |
| `risk_alerts`           | + `safety_id`                                                                                        |
| `product_reports`       | + `safety_id` (QR-abuse reports point at the Safety ID; product reports keep `helmet_id`)            |
| `helmets`               | `public_token`, `activation_pin_hash` become nullable (a helmet may now have no QR); nothing dropped |

New enums: `SafetyIdStatus` (GENERATED, PRINTED, ACTIVATED, ACTIVE, DEACTIVATED, REPLACED),
`SafetyIdOwnershipSource`, `SafetyIdBatchMode` (STANDALONE, HELMET_LINKED). `HelmetStatus` is not
reused; LOST/STOLEN/DAMAGED/RECALLED stay helmet-only.

## 3. Key decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                         | Why                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 60  | **A migrated Safety ID reuses its helmet's UUID as its id.**                                                                                                                                                                                                                                                                     | Scan, risk and escrow rows map 1:1 in SQL. The PIN escrow ciphertext (AAD = that UUID) stays decryptable with no re-encryption. Deterministic and idempotent. |
| 61  | **Migrated code = `SI-` + the Helmet ID body** (`HM-CD69-GXXR` → `SI-CD69-GXXR`).                                                                                                                                                                                                                                                | The mod-31 check symbol covers only the body, so the code is valid, unique and computable in SQL. Support can see the pairing. New codes are random.          |
| 62  | **Public token copied verbatim** into `safety_ids.public_token`.                                                                                                                                                                                                                                                                 | Printed QR labels and `/e/<token>` URLs keep working. An automated test compares every row.                                                                   |
| 63  | **PIN hash, used flag, attempts and lock copied**; escrow ciphertext copied.                                                                                                                                                                                                                                                     | Unused printed PINs keep working; consumed PINs stay consumed.                                                                                                |
| 64  | **Expand / migrate / switch; nothing dropped.** Old helmet QR/PIN columns, `helmet_emergency_settings`, `helmet_scan_daily`, `helmet_risk_*` stay.                                                                                                                                                                               | Zero-downtime deploy and rollback. Cleanup is a later dedicated release.                                                                                      |
| 65  | **Dual-write for linked Safety IDs**: sharing changes also update the linked helmet's setting and ACTIVATED↔ACTIVE status.                                                                                                                                                                                                       | The helmet lifecycle (lost/stolen restore, analytics) keeps working, and rolling the app back to Phase 8 shows the same public behaviour.                     |
| 66  | **Public state = Safety ID state, then linked-helmet lifecycle.** A lost/stolen/replaced/deactivated linked helmet still hides the profile; damaged/recalled still shows it with the warning.                                                                                                                                    | Preserves Phase 4 behaviour for helmet-linked QRs, now as an explicit relationship rule. Standalone Safety IDs never get helmet states.                       |
| 67  | **Linked Safety ID and helmet never have different owners.** Activation binds an unowned linked helmet in the same transaction. A linked helmet owned by someone else blocks activation (`SAFETY_ID_LINK_CONFLICT`).                                                                                                             | Spec §35–36.                                                                                                                                                  |
| 68  | **Transfers:** standalone Safety IDs get their own Transfer Code flow. A linked Safety ID moves with its helmet's existing transfer (the claim moves both, sharing off for the new owner). Transferring a linked Safety ID alone is blocked.                                                                                     | A safe default for §45–46 that never splits ownership. "Transfer Safety ID only, unlink" is a follow-up.                                                      |
| 69  | **Generation is a durable, resumable chunked job started by the API** (same pattern as helmet batches): atomic claim, progress in Postgres, interrupted runs marked FAILED on boot and resumable. Helmet batches with the Safety ID option create the linked Safety IDs in the same chunk transaction (one PIN hash per helmet). | No new moving part; respects the Argon2 limiter so generation never starves emergency reads.                                                                  |
| 70  | **The emergency payload has no product fields.** `PublicEmergencyDto` carries `safetyId.code` and `linkedProduct: boolean`, nothing about model, batch, serial or warranty.                                                                                                                                                      | Spec §66–67: product data belongs to `/verify`.                                                                                                               |
| 71  | **Only PRINTED Safety IDs are activatable**; the link check runs after the PIN, and every refusal (unknown, consumed, not printed, linked helmet owned by someone else) looks the same before the PIN is proven.                                                                                                                 | Keeps the Phase 8 rule and the no-oracle property.                                                                                                            |
| 72  | **Helmet routes stay as aliases** (`/add-helmet`, `/admin/analytics/helmets/…`, `/customer/helmets/:id/scan-summary`, helmet emergency enable/disable).                                                                                                                                                                          | Old clients and bookmarks keep working during the switch.                                                                                                     |
| 73  | **`risk_alerts_subject` widened** to accept `safety_id` (migration `20261012090000`).                                                                                                                                                                                                                                            | A standalone Safety ID has no helmet; found by the 100k-scan performance run, covered by an integration test.                                                 |

## 4. Status

Complete. Every non-negotiable is covered by an automated check:

| Requirement                           | Evidence                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing QR codes / URLs keep working | token copied verbatim; verify SQL; backfill fixture test; replay of 257 development tokens: 0 differences in state, profile, contacts, warnings, verify data |
| Existing unused PINs keep working     | fixture test activates with a PIN created before the migration; verify SQL                                                                                   |
| Safety IDs work without helmets       | integration tests + Playwright steps 1–10, 18–25 (standalone generate → print → activate → share → transfer → admin)                                         |
| Emergency page focuses on the person  | payload has no product fields (decision 70); Playwright asserts no Helmet ID / warranty text and the Safety ID below the facts                               |

### Tests

| Suite                         | Result                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Unit (`apps/api`)             | 308 passed                                                                                                                    |
| Integration (`apps/api/test`) | 201 passed, 20 suites (incl. `phase9-safety-id.e2e-spec.ts`, 13 tests, backfill + reconcile)                                  |
| Playwright (`e2e/`)           | 80 passed: Phase 1–8 journeys updated to Safety ID copy + `phase9-safety-id.spec.ts` (25 tests covering the 26 journey steps) |
| Performance                   | [SAFETY-ID → Performance](SAFETY-ID.md#10-performance): 5,000 generation, 100,000 scans, payload                              |

Bugs found by the new tests and fixed in this phase: risk alerts on standalone Safety IDs
violated `risk_alerts_subject` (decision 73); the admin alert workflow refreshed a pre-Phase 9
query key, so alert status changes did not show until reload.

### Deployment

High risk: see [SAFETY-ID-MIGRATION → Deployment plan](SAFETY-ID-MIGRATION.md#3-deployment-plan)
(rehearsal on a restored backup, backup first, verify + reconcile + replay, code-only rollback).
Not deployed by this phase.

### Known limitations / follow-ups

- Transferring a linked Safety ID on its own (unlink + transfer) is not offered; it moves with
  its helmet.
- The old helmet QR/PIN columns and `helmet_*` emergency/analytics tables are still written
  (dual-write) and must be removed in a later, separate cleanup release.
- Physical label format: decided by the final print update (§ 5 below).
- Generation speed is bound by Argon2id (about 27 PINs/s on 4 vCPU with the default cap).

## 5. Final print update: Safety ID sticker, six-digit PIN, 48-up

Overrides the earlier physical-print sections (A4 HTML sheet removed). Architecture unchanged:
Safety ID standalone or linked, person-first emergency page, product data only on `/verify`.
Details: [SAFETY-ID-PRINT](SAFETY-ID-PRINT.md).

| #   | Decision                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 74  | **New PINs: exactly six digits**, `crypto.randomInt(0, 10^6)` zero-padded, always a string. Same Argon2id + pepper hash and AES-GCM escrow. Legacy 8-symbol PINs still verify (no forced change).                  |
| 75  | **Third lockout layer: IP + Safety ID** (Redis, escalating, temporary) next to the per-Safety-ID row lock and per-IP/customer budgets; success clears the row and pair counters.                                   |
| 76  | **One answer before the PIN is proven**: unknown, wrong PIN and ineligible all return `INVALID_ACTIVATION_PIN` (unknown also pays one dummy Argon2 verify). Supersedes the generic NOT_ACTIVATABLE pre-PIN answer. |
| 77  | **`unit_index`** (additive migration `20261015090000`, backfilled in previous export order): deterministic print/export order; CSV rows = PDF positions.                                                           |
| 78  | **Print engine = display list → pdfkit (vector, true size) and SVG (preview only)**; geometry derived from `sticker-design.ts` and validated (cover = target + 1.5 mm, quiet zone untouched).                      |
| 79  | **Rotated Safety ID** on the credential panel so it stays visible beside the cover and the QR keeps the full height (19.15 mm incl. quiet zone).                                                                   |
| 80  | **Logo only from the original vector asset** (`PRINT_LOGO_SVG_PATH`, strict loader, first Z recoloured `#EC1C22`); production PDFs refused without it. The asset was not available in this phase.                  |
| 81  | **No PIN-bearing reprint after escrow purge** (`PIN_ESCROW_PURGED`); export never marks printed.                                                                                                                   |

### Acceptance additions

| Requirement                                         | Status / evidence                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| All new PINs six numeric digits; leading zeros work | ✅ unit (format, CSPRNG, chi-square, `004281`) + integration (`004281` activates, `4281` doesn't)                   |
| Legacy PINs remain valid                            | ✅ integration (`K7M2PQ9X`) + every older suite's fixtures use legacy PINs                                          |
| Unit exactly 4.5 × 1 in, cover inside, not 5.5 in   | ✅ unit tests (324 × 72 pt, zones sum to 4.5 in)                                                                    |
| Cover targets QR/PIN, contains no PIN               | ✅ geometry rules + unit tests (cover = target + 1.5 mm; cover words only REMOVE/ONLY IN/EMERGENCY/OPEN)            |
| Logo geometry preserved; first Z `#EC1C22`          | ⚠️ engine verified with a test fixture; **original OZZO vector not supplied** — production PDFs refused until it is |
| 12 × 18 48-up PDF; 48 = complete units              | ✅ unit + integration (1/4/47/48/49/96/100/1000/5000 units; page 1296 × 864 pt; blanks blank)                       |
| QR = real production URL; true-size PDF             | ✅ decoded from rendered output (unit test) and from the real PDF at 300 dpi at five sheet positions                |
| PDF/CSV order match; export audited; escrow purge   | ✅ integration (`phase9-print.e2e-spec.ts`)                                                                         |
| Physical cover-alignment checklist exists           | ✅ SAFETY-ID-PRINT § 9                                                                                              |
| Real printed-sheet test before mass production      | ❌ **not done** — requires a printed 12 × 18 sheet on production material                                           |

**Not print-ready for mass production** until the original logo asset is configured and one
physical sheet has been printed, measured, covered/uncovered and scanned.

### Print Designs (admin-controlled artwork)

[PRINT-DESIGNS](PRINT-DESIGNS.md). Admins upload SVG (vector, sanitized) or PNG (≥ 300 DPI,
lossless) artwork; versions are immutable once used; batches bind an exact version; the engine
keeps every dynamic element and the white credential panel. Decisions:

| #   | Decision                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 82  | **Reject, don't silently strip**, unsupported or dangerous SVG content (strict whitelist; inert editor metadata is the only thing removed). |
| 83  | **SVG as a Form XObject**, defined once per PDF (svg-to-pdfkit with loaders disabled); PNG embedded once, original bytes.                   |
| 84  | **Whole credential zone is a system white panel** over any artwork (QR, PIN, ID contrast guaranteed).                                       |
| 85  | **No seeded design**: the official logo source isn't available; old batches keep the built-in layout (`print_design_id NULL`).              |
| 86  | **Draft designs may be chosen for a batch** if they pass full validation; choosing locks them.                                              |

Tests after Print Designs: unit 400 (43 suites), integration 218 (22 suites, incl.
`phase9-print-designs.e2e-spec.ts`), Playwright 89 (incl. `phase9-print-designs.spec.ts`, 13 steps).

Tests after the final print update: unit 350 (42 suites), integration 211 (21 suites, incl.
`phase9-print.e2e-spec.ts`), Playwright 80; typecheck, lint, format and build clean.
