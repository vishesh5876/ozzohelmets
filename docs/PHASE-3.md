# Phase 3 — Ownership & helmet lifecycle

Status: **complete**. Legend: `[x]` done · `[ ]` pending

Details: [OWNERSHIP](OWNERSHIP.md) · [TRANSFER](TRANSFER.md) · [REPLACEMENT](REPLACEMENT.md) ·
[HELMET-LIFECYCLE](HELMET-LIFECYCLE.md) · [SECURITY §13](SECURITY.md#13-phase-3--ownership--lifecycle)

## Scope

Multiple helmets per customer, secure ownership transfer (existing or new recipient), lost /
stolen / damaged / retired states with restore, replacement links between two separate helmet
identities, ownership history and owner timeline, permission-gated support actions, explicit
public-page states, cache invalidation and audit for every lifecycle operation.

Out of scope (later phases): warranty, logistics, anti-counterfeit engine,
analytics, recall workflow, AWS changes, any SMS/OTP/notification provider.

## Design decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `helmet_ownerships` rows are **ownership periods** (`acquired_via`, `ended_at`, `end_reason`, `transfer_id`, `ended_by_admin_id`); existing statuses `ACTIVE`/`TRANSFERRED`/`REVOKED` kept. One ACTIVE row per helmet (partial unique index, Phase 1) + `CHECK (ACTIVE ⇔ ended_at IS NULL)`.                                                     |
| 2   | **Per-helmet emergency exposure** (`helmet_emergency_settings`, unique per helmet+user). The profile stays per user (no duplicated data). ACTIVE ⇔ this owner's switch is on. The account-level "enable" switches a helmet on implicitly only when exactly one helmet is in use. Migration backfills a switch for every helmet that was ACTIVE.  |
| 3   | **Transfer codes** `TR-XXXX-XXXX-XXXX` (~59 bits) stored only as HMAC-SHA256 in PostgreSQL (`helmet_transfers`, one PENDING per helmet) so the claim is atomic with the ownership change; Redis holds lockouts. TTL `TRANSFER_TOKEN_TTL_MINUTES` (30). Expiry is computed, not swept.                                                            |
| 4   | **Claim transaction** locks helmet → ownership → transfer; closes the old period, opens the new one, consumes the code, switches the old owner's exposure off and always lands on ACTIVATED. Recipients reuse the Phase 2 account primitives (`CustomerAccountsService`, extracted from activation).                                             |
| 5   | **Recent auth**: `POST /customer/auth/reauthenticate` / `/admin/auth/reauthenticate` → 256-bit token in Redis (SHA-256 key, 5 min, subject- and session-bound, generation counter revoked on password change/reset/logout-all), sent as `X-Recent-Auth`. Required for transfer, stolen, recovered, retire; admin revoke and forced deactivation. |
| 6   | **Owner actions are explicit endpoints** (`lost`, `found`, `stolen`, `recovered`, `damaged`, `deactivate`, `transfer`, `emergency/enable                                                                                                                                                                                                         | disable`); `ownerActions(status)`in`@helmet/types` is the single rule set used by API and UI. |
| 7   | **Restore** uses `previous_operational_status` (maintained only by `HelmetStatusService.apply`) and returns to ACTIVE only if the owner's information may still be exposed. Damaged and retired helmets are restorable only by support.                                                                                                          |
| 8   | **Public page**: only `ACTIVE` (current owner's switch on, profile complete) returns data; LOST/STOLEN/DAMAGED/REPLACED/DEACTIVATED/RECALLED are explicit data-free states. This changes Phase 2's choice to show profiles on DAMAGED/RECALLED helmets (see open decisions).                                                                     |
| 9   | **Pending transfers are cancelled centrally** whenever a helmet leaves ACTIVATED/ACTIVE (inside `apply`), so a code can't revive after e.g. lost → found.                                                                                                                                                                                        |
| 10  | **Generic admin status endpoint** can no longer set ACTIVATED/ACTIVE and needs `helmet-lifecycle:manage` for owned helmets.                                                                                                                                                                                                                      |
| 11  | **New permissions**: `ownership:view`, `ownership:revoke` (SUPER_ADMIN only), `transfer:cancel`, `replacement:manage`, `helmet-lifecycle:manage`. SUPPORT gets all but revoke; MANUFACTURING and ANALYTICS_VIEWER none.                                                                                                                          |
| 12  | **Replacement** is support-only in Phase 3: the new helmet is activated normally with its own PIN by the same customer, then linked; original → REPLACED. No identity data is copied.                                                                                                                                                            |
| 13  | **No domain-event bus.** Each service invalidates the public cache and audits explicitly after commit; an in-process emitter would add indirection without removing code today. Revisit with notifications (Phase 6).                                                                                                                            |
| 14  | Retiring or replacing a helmet keeps the ownership period ACTIVE (listed under _Retired_); only transfer and support revocation end ownership.                                                                                                                                                                                                   |

## Checklist

### Backend

- [x] Migration `20261003162224_phase3_ownership_lifecycle` (+ hand-written partial index, CHECKs, backfill)
- [x] Shared types: transfer/replacement/damage enums, public states, contracts, error codes, permissions, transition table, `ownerActions`, `helmetListGroup`
- [x] `RecentAuthService` + customer/admin reauthenticate endpoints; revocation on password change, reset, logout-all
- [x] `HelmetStatusService`: previous-operational bookkeeping, reason codes, central pending-transfer cancellation
- [x] `OwnedHelmetLocker` (helmet → ownership lock order)
- [x] `CustomerAccountsService` shared by activation and transfer claims
- [x] Transfers: create / pending / cancel / preview / claim / claim-register, lockouts, admin cancel
- [x] Lifecycle: lost, found, stolen, recovered, damaged, retire; support restore and forced deactivation
- [x] Per-helmet emergency enable/disable; account enable/disable adjusted; public view checks the current owner's switch
- [x] Replacement linking with validation and cycle prevention
- [x] Ownership history, transfer history, revocation
- [x] Customer helmet DTO: group, actions, switch, pending transfer, replacement links; owner timeline
- [x] Admin helmet detail: owner id, pending transfer, replacement links, restore target

### Frontend

- [x] My helmets grouped Active / Needs attention / Retired with quick actions
- [x] Helmet detail: per-helmet emergency switch, manage actions, timeline, pending transfer
- [x] Confirmation pages: transfer (password, code once, copy, countdown, cancel), lost, found, stolen, recovered, damaged (reason + note), retire (typed Helmet ID)
- [x] Claim page (existing sign-in or new account + recovery code once)
- [x] Per-helmet switches on the emergency profile card when several helmets are in use
- [x] Emergency page states for damaged / replaced / deactivated / recalled (5.3 kB JS)
- [x] Admin: ownership history, transfers, replacement, support actions (password re-check), new permission labels

### Quality

- [x] Unit tests (transition table, lifecycle policy, transfer codes, public states)
- [x] Integration tests incl. claim races and claim-vs-stolen race
- [x] Playwright 27-step journey
- [x] Docs

## Results

### Verification

| Check                                                               | Result                                                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm format:check` | pass                                                                                                                                                                                                                                 |
| API unit tests                                                      | 163 passed (23 suites; Phase 2: 153)                                                                                                                                                                                                 |
| API integration tests (PostgreSQL + Redis)                          | 102 passed (11 suites; Phase 2: 73) — incl. two-recipient claim race and claim-vs-stolen race (3 rounds each)                                                                                                                        |
| Playwright                                                          | 18/18 (Phase 2 journey 10 + Phase 3 journey 8 tests covering all 27 steps, mobile viewport for public pages)                                                                                                                         |
| Docker                                                              | API, portal and admin images built; API container applied all 4 migrations on an empty database, passed health and served Phase 3 endpoints; portal nginx serves `/claim` and `/app/*` from the SPA and `/e/*` from `emergency.html` |
| Migrations on a fresh database (Phase 1 → 2 → 3)                    | `prisma migrate deploy` on an empty database: 4 migrations applied, `migrate status` up to date, `migrate diff` against the schema: no drift. Backfill verified on the dev database (8/8 ACTIVE helmets received a switch)           |

### Migrations

`20261003162224_phase3_ownership_lifecycle` — new enums `OwnershipAcquisition`, `TransferStatus`,
`ReplacementReason`; columns on `helmet_ownerships`, `helmets.previous_operational_status`,
`helmet_status_history.reason_code`; tables `helmet_transfers`, `helmet_replacements`,
`helmet_emergency_settings`; partial unique index for PENDING transfers; CHECKs; backfill of
ended periods and of switches for ACTIVE helmets. Not yet applied to the external database —
apply with `prisma migrate deploy`.

## Business decisions still open

1. _(Decided in Phase 4: permanent Customer ID sign-in.)_ **Transferring away your only helmet** leaves the account without a sign-in identifier (identity
   = ownership). The account, profile and history remain. Options: keep as is; let customers add
   another sign-in method later; or delete/anonymise orphaned accounts after N days.
2. _(Decided in Phase 4: already-shared information stays visible with a warning.)_ **Damaged / recalled helmets now hide emergency data.** A rider may still wear a damaged or
   recalled helmet; Phase 2 showed the profile in these states. Confirm the conservative default.
3. **Lost helmets**: offer an optional owner-chosen "if found, contact" line? Currently nothing.
4. **Revoked ownership follow-up**: who may re-assign an ownerless helmet and how (PIN re-issue +
   new activation is the natural path; not built).
5. **Customer-initiated replacement** (warranty flow) — Phase 4/5.

## Deferred (intentional)

- Notifications to the previous owner when a transfer is claimed (no provider by decision).
- Domain-event bus; periodic sweep marking expired transfers EXPIRED (computed on read today).
- Admin "PIN re-issue" for unactivated helmets whose escrow was purged.
- S3 storage provider (unchanged from Phase 2).

## Recommended before Phase 4

- Apply all three migrations to the external database and run the seed only locally.
- Decide the open items above (especially #1 and #2).
- Add an admin "customer" view (helmets per customer) on top of `ownership:view`.
- Consider moving the transfer HMAC key to a dedicated secret (today derived from
  `CUSTOMER_CREDENTIAL_PEPPER` with domain separation).
