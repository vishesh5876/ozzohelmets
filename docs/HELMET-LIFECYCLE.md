# Helmet lifecycle

Every status change goes through `HelmetStatusService` (API) using the transition table in
`packages/types/src/lifecycle.ts`, shared with the admin UI (which only offers allowed targets).
Each change writes a `helmet_status_history` row; admin changes are also audited.

## Statuses

| Status            | Meaning                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `GENERATED`       | Identity created in a batch; labels not yet confirmed printed.         |
| `PRINTED`         | Labels printed and attached (batch "mark printed"). PIN escrow purged. |
| `IN_INVENTORY`    | In a warehouse / distributor stock.                                    |
| `SOLD`            | Sold to an end customer (dealer flow, Phase 5).                        |
| `ACTIVATED`       | Customer completed activation; ownership exists.                       |
| `ACTIVE`          | Owner completed emergency-profile setup (Phase 2).                     |
| `LOST` / `STOLEN` | Reported by owner or support.                                          |
| `DAMAGED`         | Physically damaged / crash-involved.                                   |
| `RECALLED`        | Subject to a product recall.                                           |
| `REPLACED`        | Replaced by another helmet (terminal).                                 |
| `DEACTIVATED`     | Permanently taken out of service (terminal).                           |

## Transitions (actor: A = admin, S = system, O = owner)

```
GENERATED ──A,S──► PRINTED ──A──► IN_INVENTORY ──A──► SOLD ──S──► ACTIVATED
    │                                │                  └──A──► IN_INVENTORY (return)
    └─A─► DEACTIVATED                └──S──► ACTIVATED  (only while ACTIVATION_ALLOW_IN_INVENTORY=true)

ACTIVATED ──S,O──► ACTIVE   (owner enables the emergency profile)
ACTIVE ──S,O──► ACTIVATED   (owner disables the emergency profile)
ACTIVATED / ACTIVE ──O,A──► LOST | STOLEN | DAMAGED
ACTIVE ──A──► REPLACED | RECALLED | DEACTIVATED
LOST ──O,A──► ACTIVE | STOLEN      LOST/STOLEN ──A──► REPLACED | DEACTIVATED
STOLEN ──O,A──► ACTIVE
DAMAGED / RECALLED ──A──► REPLACED | DEACTIVATED
PRINTED / IN_INVENTORY / SOLD ──A──► DAMAGED | RECALLED | DEACTIVATED
REPLACED, DEACTIVATED: terminal
```

The authoritative list is `HELMET_STATUS_TRANSITIONS`. Unit tests verify: every status is in the
table, no self-loops, every status reachable from `GENERATED`, terminal states have no exits,
only `SYSTEM` can activate, owners can report lost/stolen but not deactivate/recall.

## Design rules

- **Eligibility** is decided only by `ActivationPolicy` (see ACTIVATION.md).
- **Activation is system-only.** No admin can move a helmet to `ACTIVATED`; only the Phase 2
  activation flow (PIN as proof of possession, row-locked transaction) can, so ownership always exists.
- **Concurrency.** Single changes lock the row (`SELECT … FOR UPDATE`) and update with
  `WHERE status = <from>`; a concurrent change fails with `CONFLICT` rather than overwriting.
- **Bulk changes** (mark printed) validate the transition once and apply it in one transaction
  with history rows inserted via `INSERT … SELECT`.
- **Public cache** for the QR page is invalidated after every status change.

## Public page mapping

| Status                                 | Public state                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GENERATED, PRINTED, IN_INVENTORY, SOLD | `NOT_ACTIVATED` — "This helmet has not yet been activated."                                                                        |
| ACTIVATED, ACTIVE                      | `ACTIVE`                                                                                                                           |
| DAMAGED, RECALLED                      | `ACTIVE` if the helmet has an owner (emergency info must stay reachable for a rider wearing a recalled helmet), else `UNAVAILABLE` |
| LOST, STOLEN                           | `LOST` / `STOLEN` safe message (whether emergency info is still shown is a Phase 3 product decision)                               |
| REPLACED, DEACTIVATED                  | `UNAVAILABLE`                                                                                                                      |

## Flagged business decisions

1. **Decided (Phase 2):** customers activate from `SOLD`; `IN_INVENTORY` only via the temporary
   `ACTIVATION_ALLOW_IN_INVENTORY` allowance (`ActivationPolicy`). `PRINTED → ACTIVATED` was removed.
   Retailers must therefore move helmets to SOLD (admin today, dealer scanning in Phase 5).
2. **Decided (Phase 2):** `ACTIVATED` = owned, PIN consumed; `ACTIVE` = owner explicitly enabled a
   complete emergency profile. Disabling returns the helmet to `ACTIVATED`.
3. Lost/stolen helmets: show emergency info or only a status message? (Phase 3.)
