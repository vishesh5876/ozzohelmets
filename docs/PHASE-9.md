# Phase 9: Safety ID architecture and standalone Emergency QR

**The Safety ID is the emergency identity. A helmet is an optional linked product.**

Before Phase 9 the chain was Helmet → QR → Activation PIN → emergency profile. Phase 9 makes
the QR an **Emergency Safety ID** (`SI-XXXX-XXXX`) that owns the public token, the Activation
PIN, the current owner, emergency sharing, scans and QR risk. It can be linked to at most one
helmet, or to none (a free standalone sticker or card). Existing printed QR codes, URLs and
unused PINs keep working unchanged.

Detailed references: [SAFETY-ID](SAFETY-ID.md) (domain and rules) ·
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

| #   | Decision                                                                                                                                                                                                                                     | Why                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 60  | **A migrated Safety ID reuses its helmet's UUID as its id.**                                                                                                                                                                                 | Scan, risk and escrow rows map 1:1 in SQL. The PIN escrow ciphertext (AAD = that UUID) stays decryptable with no re-encryption. Deterministic and idempotent. |
| 61  | **Migrated code = `SI-` + the Helmet ID body** (`HM-CD69-GXXR` → `SI-CD69-GXXR`).                                                                                                                                                            | The mod-31 check symbol covers only the body, so the code is valid, unique and computable in SQL. Support can see the pairing. New codes are random.          |
| 62  | **Public token copied verbatim** into `safety_ids.public_token`.                                                                                                                                                                             | Printed QR labels and `/e/<token>` URLs keep working. An automated test compares every row.                                                                   |
| 63  | **PIN hash, used flag, attempts and lock copied**; escrow ciphertext copied.                                                                                                                                                                 | Unused printed PINs keep working; consumed PINs stay consumed.                                                                                                |
| 64  | **Expand / migrate / switch; nothing dropped.** Old helmet QR/PIN columns, `helmet_emergency_settings`, `helmet_scan_daily`, `helmet_risk_*` stay.                                                                                           | Zero-downtime deploy and rollback. Cleanup is a later dedicated release.                                                                                      |
| 65  | **Dual-write for linked Safety IDs**: sharing changes also update the linked helmet's setting and ACTIVATED↔ACTIVE status.                                                                                                                   | The helmet lifecycle (lost/stolen restore, analytics) keeps working, and rolling the app back to Phase 8 shows the same public behaviour.                     |
| 66  | **Public state = Safety ID state, then linked-helmet lifecycle.** A lost/stolen/replaced/deactivated linked helmet still hides the profile; damaged/recalled still shows it with the warning.                                                | Preserves Phase 4 behaviour for helmet-linked QRs, now as an explicit relationship rule. Standalone Safety IDs never get helmet states.                       |
| 67  | **Linked Safety ID and helmet never have different owners.** Activation binds an unowned linked helmet in the same transaction. A linked helmet owned by someone else blocks activation (`SAFETY_ID_LINK_CONFLICT`).                         | Spec §35–36.                                                                                                                                                  |
| 68  | **Transfers:** standalone Safety IDs get their own Transfer Code flow. A linked Safety ID moves with its helmet's existing transfer (the claim moves both, sharing off for the new owner). Transferring a linked Safety ID alone is blocked. | A safe default for §45–46 that never splits ownership. "Transfer Safety ID only, unlink" is a follow-up.                                                      |
| 69  | **Generation runs in the worker** for Safety ID batches (durable progress in Postgres, resumable). Helmet batches with the Safety ID option create the linked Safety IDs in the same chunked transactions.                                   | Respects the Argon2 limiter; doesn't starve the API.                                                                                                          |
| 70  | **The emergency payload has no product fields.** `PublicEmergencyDto` carries `safetyId.code` and `linkedProduct: boolean`, nothing about model, batch, serial or warranty.                                                                  | Spec §66–67: product data belongs to `/verify`.                                                                                                               |

## 4. Status

See the sections below; filled in as work completes.
