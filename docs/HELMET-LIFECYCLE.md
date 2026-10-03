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

## Transitions (actor: A = admin/support, S = system, O = owner)

```
GENERATED ──A,S──► PRINTED ──A──► IN_INVENTORY ──A──► SOLD ──S──► ACTIVATED
    │                                │                  └──A──► IN_INVENTORY (return)
    └─A─► DEACTIVATED                └──S──► ACTIVATED  (only while ACTIVATION_ALLOW_IN_INVENTORY=true)

ACTIVATED ──S,O──► ACTIVE        owner switches emergency info on for this helmet
ACTIVE ──S,O,A──► ACTIVATED      switch off · ownership transferred (S) · ownership revoked (A)
ACTIVATED / ACTIVE ──O,A──► LOST | STOLEN | DAMAGED | DEACTIVATED (retire)
ACTIVATED / ACTIVE ──A──► REPLACED | RECALLED
LOST   ──O,A──► ACTIVE | ACTIVATED (found) | STOLEN | DEACTIVATED      ──A──► REPLACED
STOLEN ──O,A──► ACTIVE | ACTIVATED (recovered) | DEACTIVATED          ──A──► REPLACED
DAMAGED ──O,A──► DEACTIVATED      ──A──► ACTIVE | ACTIVATED (support restore) | REPLACED
RECALLED ──A──► REPLACED | DEACTIVATED
DEACTIVATED ──A──► ACTIVATED      (support restore of an owned helmet only)
REPLACED: terminal
PRINTED / IN_INVENTORY / SOLD ──A──► DAMAGED | RECALLED | DEACTIVATED
```

The authoritative list is `HELMET_STATUS_TRANSITIONS`; `ownerActions(status)` (same file) is the
single list of explicit owner actions per status, used by the API to authorise and by the portal
to show buttons. Unit tests verify: every status in the table, no self-loops, reachability from
`GENERATED`, REPLACED terminal, only `SYSTEM` activates, owner vs support edges.

## Owner actions (Phase 3)

| Action         | Endpoint (`/customer/helmets/:id/…`) | From                    | To                  | Recent password |
| -------------- | ------------------------------------ | ----------------------- | ------------------- | --------------- |
| Emergency on   | `emergency/enable`                   | ACTIVATED               | ACTIVE              | –               |
| Emergency off  | `emergency/disable`                  | ACTIVE                  | ACTIVATED           | –               |
| Transfer       | `transfer` (see TRANSFER.md)         | ACTIVATED, ACTIVE       | (owner changes)     | yes             |
| Report lost    | `lost`                               | ACTIVATED, ACTIVE       | LOST                | –               |
| Mark found     | `found`                              | LOST                    | previous safe state | –               |
| Report stolen  | `stolen`                             | ACTIVATED, ACTIVE, LOST | STOLEN              | yes             |
| Mark recovered | `recovered`                          | STOLEN                  | previous safe state | yes             |
| Mark damaged   | `damaged` `{reason?, note?}`         | ACTIVATED, ACTIVE       | DAMAGED             | –               |
| Retire         | `deactivate` `{confirmHelmetCode}`   | ACTIVATED…DAMAGED       | DEACTIVATED         | yes             |

There is no generic "set status" for customers.

### Restoring to the previous safe state

`helmets.previous_operational_status` is maintained **only** by `HelmetStatusService.apply`:
entering LOST/STOLEN/DAMAGED from ACTIVE/ACTIVATED records it, moving between interruptions keeps
it, anything else clears it. `restoreTarget(previous, canExpose)` returns ACTIVE only if the
helmet was ACTIVE **and** the owner's information may still be exposed on it (per-helmet switch
on, profile enabled and complete); otherwise ACTIVATED. Owner "found"/"recovered" and the support
restore all use this one function.

## Design rules

- **Eligibility** for activation is decided only by `ActivationPolicy` (see ACTIVATION.md).
- **Operational statuses are never set by hand.** ACTIVATED/ACTIVE are reached only through
  activation, per-helmet enablement, transfer, or the support restore; the generic admin status
  endpoint refuses them, and changing a customer-owned helmet there requires
  `helmet-lifecycle:manage` (so MANUFACTURING can't touch owned helmets).
- **Concurrency.** Every lifecycle change locks the helmet row, then its ACTIVE ownership row
  (`OwnedHelmetLocker`), and updates with `WHERE status = <from>`.
- **Pending transfers die** whenever a helmet leaves ACTIVATED/ACTIVE (central, in `apply`).
- **History** rows carry a machine `reason_code` (e.g. `LOST_REPORTED`, `DAMAGED:ACCIDENT`,
  `TRANSFERRED`, `RESTORED_BY_SUPPORT`); free text is limited to short admin reasons and an
  optional ≤200-char owner damage note.
- **Public cache** for the QR page is invalidated after every change (status, owner, settings).

## Public page mapping

`ACTIVE` returns emergency information when the **current** owner's per-helmet switch is on and
their profile is enabled and complete. Since Phase 4, `DAMAGED` and `RECALLED` keep that approved
information **only if the helmet was already sharing** (same conditions), with a warning shown
first; everything else returns a status message only. See
[PRODUCT-AUTHENTICITY](PRODUCT-AUTHENTICITY.md#public-emergency-rule-revised-in-phase-4).

| Status                                 | Public state / message                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GENERATED, PRINTED, IN_INVENTORY, SOLD | `NOT_ACTIVATED` — "This helmet has not yet been activated."                                                                               |
| ACTIVE (+ switch on, profile complete) | `ACTIVE` — owner-approved fields only                                                                                                     |
| ACTIVATED / ACTIVE otherwise           | `ACTIVATED_PROFILE_INCOMPLETE` (no owner → `UNAVAILABLE`)                                                                                 |
| LOST                                   | `LOST` — "This helmet has been reported lost."                                                                                            |
| STOLEN                                 | `STOLEN` — "This helmet has been reported stolen."                                                                                        |
| DAMAGED                                | `DAMAGED` — already sharing: approved info + "This helmet is marked as damaged."; otherwise "This helmet is currently marked as damaged." |
| REPLACED                               | `REPLACED` — "This helmet has been replaced and is no longer active."                                                                     |
| DEACTIVATED                            | `DEACTIVATED` — "This helmet is no longer active."                                                                                        |
| RECALLED                               | `RECALLED` — already sharing: approved info + recall warning; otherwise status message only                                               |

## Flagged business decisions

1. **Decided (Phase 2):** customers activate from `SOLD`; `IN_INVENTORY` only via the temporary
   `ACTIVATION_ALLOW_IN_INVENTORY` allowance.
2. **Decided (Phase 2/3):** `ACTIVATED` = owned; `ACTIVE` = owner explicitly switched emergency
   information on **for this helmet**.
3. **Decided (Phase 3, revised Phase 4):** lost, stolen, replaced and deactivated helmets show a
   status message only — no medical data or contacts. Damaged and recalled helmets keep the
   owner-approved information if they were already sharing, with a warning (a damaged helmet is
   typically scanned right after the crash). Open: should LOST helmets optionally show an
   owner-chosen "if found, call" contact?
4. **Phase 4:** a warranty is per helmet and survives these states; registration is allowed in
   ACTIVATED, ACTIVE, LOST, STOLEN, DAMAGED and RECALLED. See [WARRANTY](WARRANTY.md).
