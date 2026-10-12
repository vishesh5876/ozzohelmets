# Safety ID

**The Safety ID is the emergency identity. A helmet is an optional linked product.**

A Safety ID (`SI-XXXX-XXXX`) is the QR code that shows a person's emergency information when it
is scanned. It owns:

- the public token behind the QR URL (`/e/<token>`, verify page `/verify/<token>`);
- the one-time Activation PIN (Argon2id + pepper), its escrow until printing, its used flag,
  attempts and lock;
- its current owner and ownership history;
- emergency sharing (one switch per Safety ID and owner);
- scans, daily aggregates, review signals, risk assessment and risk alerts;
- QR integrity (normal / under review / compromised);
- at most one linked helmet (or none: a standalone sticker or card).

The helmet keeps what belongs to the product: Helmet ID, serial, model, batch, warranty,
lifecycle (lost, stolen, damaged, recalled, replaced, retired), product reports and authenticity.

See also: [PHASE-9](PHASE-9.md) (decisions, status) ·
[SAFETY-ID-MANUFACTURING](SAFETY-ID-MANUFACTURING.md) ·
[SAFETY-ID-MIGRATION](SAFETY-ID-MIGRATION.md).

## 1. Identifiers

| Identifier     | Format                                       | Notes                                                                                                                                        |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Safety ID code | `SI-` + 4 + `-` + 3 + check symbol (mod 31)  | Same alphabet and check as Helmet ID. New codes are random; migrated codes are `SI-` + the Helmet ID body (`HM-CD69-GXXR` → `SI-CD69-GXXR`). |
| Public token   | 22 base62 symbols (~131 bits)                | Unique across Safety IDs. Migrated Safety IDs keep the helmet's token, so printed labels keep working.                                       |
| Activation PIN | 8 symbols (~39.6 bits), unambiguous alphabet | Printed once. Stored only as Argon2id + `PIN_HASH_PEPPER`. Escrowed (AES-256-GCM, AAD = Safety ID id) until the batch is printed.            |
| Transfer Code  | one-time code, peppered hash, expiry         | Standalone Safety ID transfers only.                                                                                                         |

## 2. Status

```
GENERATED ──print──► PRINTED ──activate (PIN)──► ACTIVATED ◄──sharing on/off──► ACTIVE
    │                   │                           │  │                           │
    └──deactivate──►  DEACTIVATED ◄────────────────┘  └──replace──► REPLACED ◄────┘
                        │  reactivate → ACTIVATED (owner kept) or PRINTED (never activated)
```

| From        | Allowed to                       |
| ----------- | -------------------------------- |
| GENERATED   | PRINTED, DEACTIVATED             |
| PRINTED     | ACTIVATED, DEACTIVATED           |
| ACTIVATED   | ACTIVE, DEACTIVATED, REPLACED    |
| ACTIVE      | ACTIVATED, DEACTIVATED, REPLACED |
| DEACTIVATED | ACTIVATED, PRINTED               |
| REPLACED    | — (terminal)                     |

Only **PRINTED** Safety IDs can be activated (as in Phase 8: an unprinted label never reaches a
customer). `ACTIVE` means "owned and sharing on with a publishable profile"; `ACTIVATED` means
owned but not sharing. The transitions live in `packages/types/src/safety-id.ts`
(`SAFETY_ID_TRANSITIONS`, `SAFETY_ID_ACTIVATABLE`) and are enforced in `SafetyIdCoreService`.

## 3. Public behaviour

The public emergency page is about the **person**: emergency facts in priority order (name,
blood group, conditions, allergies, medications, other notes), contacts with call buttons, the
emergency-services button, then the Safety ID code at the bottom. It never shows model, batch,
serial, warranty or the Helmet ID. A "View product information" link to `/verify/<token>`
appears only when a helmet is linked.

Public state is decided in this order (`public-emergency/public-state.ts`):

1. Safety ID `DEACTIVATED` / `REPLACED` → no longer active.
2. Linked helmet lifecycle, applied even before activation: `LOST` / `STOLEN` → reported lost /
   stolen (no profile); `REPLACED` / `DEACTIVATED` helmet → no longer active (no profile);
   `DAMAGED` / `RECALLED` → profile still shown (if shared) with the warning.
3. `GENERATED` / `PRINTED` → "Safety ID not activated" with the activation link.
4. No current owner → unavailable.
5. Sharing on and a publishable profile → `ACTIVE` with the profile; otherwise "registered, but
   its owner has not shared emergency information".

The verify page shows "✓ Safety ID verified / This Safety ID is registered with Ozzo. No
registered product is currently linked to this Safety ID." for a standalone Safety ID, and the
product identity (model, batch, warranty, lifecycle) for a linked one. QR integrity
`COMPROMISED` adds a neutral "please contact support" notice on the verify page only; the
emergency page always keeps working.

Public responses are cached in Redis (`public-emergency:v3:<token>`, `public-verify:v2:<token>`)
and invalidated on every change to the Safety ID, its link, its owner's profile, contacts,
visibility or sharing.

## 4. Activation

Activation starts from the Safety ID (scan → `/activate?t=<token>`, or type the Safety ID):
"Activate your Safety ID — Enter the Activation PIN printed with your Safety ID."

1. `POST /customer/activation/validate` checks the PIN (Argon2id, attempts and lock per Safety
   ID, global Argon2 concurrency cap). Unknown, consumed, non-activatable or conflicting Safety
   IDs all get the same generic answer (no oracle).
2. A new customer creates an account (`/register`); a signed-in customer uses
   `/add-safety-id` (`/add-helmet` is kept as an alias).
3. In one transaction (lock order: helmet → helmet ownership → Safety ID → Safety ID
   ownership): the PIN is consumed, the escrow deleted, the Safety ID becomes `ACTIVATED` with
   an ACTIVE ownership (source `ACTIVATION`); a linked, unowned helmet becomes the customer's
   in the same transaction. A linked helmet owned by someone else → `SAFETY_ID_LINK_CONFLICT`
   and nothing changes.
4. Success screen: "Your Safety ID is activated." with the code and "Emergency Sharing: Not
   enabled yet", then emergency setup or "Do it later".

## 5. Sharing

The emergency profile, contacts and visibility stay **account-wide**. Each Safety ID has its own
sharing switch (`safety_id_emergency_settings`), so a customer with several Safety IDs (helmet
QR, wallet card, bike sticker) chooses where the profile shows. Turning one off never affects
another. For a linked Safety ID the switch is mirrored onto the helmet's Phase 8 setting and
status (dual-write) so helmet lifecycle rules and a Phase 8 rollback behave the same.

Customer endpoints: `POST /customer/safety-ids/:id/emergency/enable|disable`; onboarding takes
`?safetyId=`; `POST /customer/emergency-profile/enable` accepts `{ safetyIds, helmetIds }`.

## 6. Ownership and transfer

- A linked Safety ID and its helmet never have different owners.
- **Standalone** Safety IDs move with a **Transfer Code**: the owner confirms their password,
  gets a one-time code (shown once, hashed at rest, expiring); the recipient enters the Safety
  ID and code at `/claim?type=safety-id` (signed in, or creating an account). On claim the old
  ownership ends, sharing is off for the new owner, the previous owner's data stops showing
  immediately.
- A **linked** Safety ID moves with its helmet's transfer (Phase 3 flow). Transferring a linked
  Safety ID on its own is refused (`SAFETY_ID_NOT_TRANSFERABLE`).
- Admin: revoke ownership (super admin, password confirmed), cancel a pending transfer.

## 7. Admin

Navigation: **Safety IDs** (list, search by Safety ID / Helmet ID / Customer ID / batch,
filters by status, linked/standalone, QR integrity, batch) and **Safety ID Batches**. The
Safety ID page shows status, Activation PIN state (available / exported / escrow purged /
consumed — never the PIN), owner, linked helmet, batch, ownership history, QR and support
actions: deactivate (password confirmed), reactivate, link to a helmet, unlink, QR integrity,
revoke ownership. The customer page lists Safety IDs separately from helmets; global and
customer search accept `SI-` codes.

| Permission            | SUPER_ADMIN | ADMIN | MANUFACTURING | SUPPORT | ANALYTICS_VIEWER |
| --------------------- | ----------- | ----- | ------------- | ------- | ---------------- |
| `safety-ids:read`     | ✓           | ✓     | ✓             | ✓       |                  |
| `safety-ids:generate` | ✓           | ✓     | ✓             |         |                  |
| `safety-ids:export`   | ✓           | ✓     | ✓             |         |                  |
| `safety-ids:manage`   | ✓           | ✓     |               |         |                  |
| `ownership:revoke`    | ✓           |       |               |         |                  |
| `qr-integrity:manage` | ✓           | ✓     |               |         |                  |

Every action is audited (`SAFETY_ID_*` audit actions); exports record the number of PINs
included.

## 8. API

| Method + path                                                                                   | Who                            | Purpose                                    |
| ----------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------ |
| `GET /public/emergency/:token`, `GET /public/verify/:token`                                     | public                         | unchanged URLs; Safety-ID-centric payloads |
| `POST /customer/activation/validate`, `/register`, `/add-safety-id`                             | public / customer              | activation (`/add-helmet` = alias)         |
| `GET /customer/safety-ids`, `GET /customer/safety-ids/:id`                                      | customer                       | My Safety IDs, detail                      |
| `GET /customer/safety-ids/:id/qr`                                                               | customer                       | QR PNG                                     |
| `POST /customer/safety-ids/:id/emergency/enable` / `disable`                                    | customer                       | per-Safety-ID sharing                      |
| `POST` / `DELETE /customer/safety-ids/:id/transfer`                                             | customer (recent auth)         | Transfer Code (standalone only)            |
| `POST /customer/safety-id-transfers/claim`, `/claim/register`                                   | customer / public              | claim with Safety ID + Transfer Code       |
| `GET /customer/safety-ids/:id/scan-summary`                                                     | customer                       | neutral scan count                         |
| `GET /admin/safety-ids`, `/metrics`, `/:id`, `/:id/qr`                                          | `safety-ids:read`              | list / search / detail                     |
| `POST /admin/safety-ids/:id/deactivate` (recent auth), `/reactivate`, `/link`, `/unlink`        | `safety-ids:manage`            | support actions                            |
| `POST /admin/safety-ids/:id/qr-integrity`                                                       | `qr-integrity:manage`          | QR integrity                               |
| `POST /admin/safety-ids/:id/revoke-ownership` (recent auth)                                     | `ownership:revoke`             | standalone only                            |
| `DELETE /admin/safety-ids/:id/transfer`                                                         | `transfer:cancel`              | cancel a pending transfer                  |
| `GET/POST /admin/safety-id-batches`, `GET /:id`, `POST /:id/generate`, `POST /:id/mark-printed` | `safety-ids:read` / `generate` | batches                                    |
| `GET /admin/safety-id-batches/:id/export/safety-ids.csv`, `/print-sheet.html`                   | `safety-ids:export`            | PIN exports (until printed)                |
| `GET /admin/analytics/safety-ids[/:code]`, `…/:code/scans`, `PATCH …/:code/qr-integrity`        | `analytics:view`               | QR activity; `/helmets/…` kept as aliases  |

Error codes: `SAFETY_ID_NOT_FOUND`, `SAFETY_ID_ALREADY_ACTIVATED`, `SAFETY_ID_NOT_ACTIVATABLE`,
`SAFETY_ID_HAS_OWNER`, `SAFETY_ID_LINK_CONFLICT`, `SAFETY_ID_ACTION_NOT_ALLOWED`,
`SAFETY_ID_NOT_TRANSFERABLE`.

## 9. Analytics and risk

Scans carry `safety_id` (and `helmet_id` when linked). Daily aggregates, review signals, risk
assessments and alerts are per Safety ID (`safety_id_scan_daily`, `safety_id_risk_*`, alert
dedup key `safety:<id>:volume|anomaly`). Admin "QR activity" lists Safety IDs with their linked
helmet (or "Standalone"). Platform stats: active emergency profiles = ACTIVE Safety IDs; unique
QRs scanned = unique Safety IDs. Customers see only a neutral count ("Your Safety ID QR was
accessed N times in the last 30 days.").

## 10. Performance

`apps/api/scripts/perf-safety-id.ts` (dedicated `*_perf` database only) and
`apps/api/scripts/perf-emergency-payload.ts` (against a running API). Development container,
4 vCPU, PostgreSQL 16 local:

| Step                                                                  | Result                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Generate 5,000 standalone Safety IDs (real job, 73 queries)           | 188 s, COMPLETED, 5,000 escrowed PINs                                                |
| Export CSV, 5,000 rows (stream)                                       | 0.3 s, 440 KB                                                                        |
| Print sheet, 5,000 labels (stream)                                    | 4.7 s, 10.7 MB HTML                                                                  |
| Mark printed (status + escrow purge)                                  | 0.15 s, escrow 0                                                                     |
| 6,000 Safety IDs / 100,000 scans: 30-day aggregation backfill         | 2.5 s (96 queries); steady state 0.15 s                                              |
| Risk evaluation (10 hot Safety IDs), first / repeat                   | 0.41 s / 0.26 s, 10 deduplicated alerts                                              |
| Admin reads: overview / scans / QR activity / detail / scans / alerts | 18 / 136 / 14 / 13 / 6 / 4 ms                                                        |
| Emergency payload (ACTIVE: name, blood group, allergy, 1 contact)     | 390 B (288 B gzip); 500 sequential: cold 125 ms, p50 3.5 ms, p95 7.3 ms, p99 10.5 ms |
| Verify payload (linked helmet)                                        | 525 B (380 B gzip); p50 2.9 ms, p95 4.6 ms                                           |

Generation time is Argon2id PIN hashing (about 27 PINs/s with the per-process concurrency cap
that protects emergency reads; Phase 7 decision 56). It runs as a background job with durable
progress, so the admin page polls and an interrupted run resumes. The largest possible
emergency payload, computed from the validation limits (3 lists × 20 items × 100 characters,
1,000-character notes, 5 contacts), is about 9 KB of JSON before gzip; not measured.
