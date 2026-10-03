# Helmet replacement

A replacement is a **physically different helmet** with its own Helmet ID, QR, barcode,
activation PIN and serial. Identities are never reused, moved or copied.

## Model: `helmet_replacements`

| Column                  | Notes                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| `original_helmet_id`    | unique — a helmet is replaced at most once                         |
| `replacement_helmet_id` | unique — a helmet replaces at most one other                       |
| `reason`                | `DAMAGED`, `DEFECTIVE`, `ACCIDENT`, `SUPPORT_REPLACEMENT`, `OTHER` |
| `notes`                 | optional, ≤ 500 chars (support)                                    |
| `created_by_admin_id`   | who linked it                                                      |

`CHECK (original_helmet_id <> replacement_helmet_id)`; cycles are rejected by walking the chain.

## Flow (Phase 3: support/admin only)

1. The customer receives the new helmet and **activates it normally with its own PIN** (as an
   additional helmet on the same account).
2. Support (`replacement:manage`) links it: `POST /admin/replacements
{originalHelmetId, replacementHelmetCode, reason, notes?}`.
3. In one transaction (both helmet rows locked in id order): validate → insert link → original
   → `REPLACED` (ADMIN, reason code `REPLACED:<reason>`) → original's emergency switch off →
   pending transfer cancelled → audit `helmet.replacement.linked` → invalidate cache.

Validation: different helmets; original currently owned and in ACTIVATED/ACTIVE/LOST/STOLEN/
DAMAGED/RECALLED; replacement owned by the **same** customer and ACTIVATED/ACTIVE; neither
already linked; no cycle. Any failure → `REPLACEMENT_INVALID`.

## Emergency information

The profile belongs to the customer, so the replacement can use it — but only after the customer
explicitly switches it on for the replacement helmet. The old helmet's public page shows
"This helmet has been replaced and is no longer active."

## Not in Phase 3

Warranty claims, customer-initiated replacement requests and logistics.
