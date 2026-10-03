# Ownership

A **helmet** and a **customer account** are separate entities. A customer can own many helmets;
a helmet can have many owners over time — but **at most one current owner**.

## Model: `helmet_ownerships` = ownership periods

| Column              | Meaning                                                   |
| ------------------- | --------------------------------------------------------- |
| `status`            | `ACTIVE` (current), `TRANSFERRED`, `REVOKED` (by support) |
| `acquired_via`      | `ACTIVATION` (PIN) or `TRANSFER`                          |
| `activated_at`      | Start of the period                                       |
| `ended_at`          | End of the period; NULL ⇔ ACTIVE (CHECK constraint)       |
| `end_reason`        | `TRANSFER`, `ADMIN_REVOKED`                               |
| `transfer_id`       | Transfer that started / ended the period                  |
| `ended_by_admin_id` | Admin who revoked it                                      |

Invariants (enforced in the database where possible):

- **One current owner:** partial unique index `helmet_ownerships(helmet_id) WHERE status='ACTIVE'`.
- **History is never overwritten:** periods are only closed (status + `ended_at`), never deleted
  (`ON DELETE RESTRICT` from helmets and users).
- **Period consistency:** `CHECK ((status = 'ACTIVE') = (ended_at IS NULL))`.
- The current owner is always "the ACTIVE row" — there is no owner column on `helmets`.

Retiring (DEACTIVATED) or replacing a helmet does **not** end ownership: the helmet stays in the
owner's list (under _Retired_) and its history remains visible to them.

## Identity follows ownership

Customers sign in with any Helmet ID they **currently** own. After a transfer the Helmet ID
identifies the new owner; a customer who transfers away their only helmet can no longer sign in
(flagged in PHASE-3.md).

## Who sees what

- **Owner:** their helmets, and a timeline that starts at _their_ ownership — earlier owners'
  events are never shown, nor are previous owners' identities.
- **Support** (`ownership:view`): all periods with customer id, masked (unverified) mobile,
  dates, end reason and the admin who revoked; transfer history without codes. Never decrypted
  medical data.

## Emergency information belongs to the user

The medical profile, contacts and visibility belong to the **user**. Whether a **helmet**
exposes them is a per-(helmet, user) switch in `helmet_emergency_settings`. Consequences:

- A transferred helmet never shows the previous owner's data: their switch is turned off in the
  claim transaction, the helmet drops to ACTIVATED, and the public view checks the **current**
  owner's switch.
- A new owner's data appears only after they explicitly switch it on for that helmet.
- With several helmets, enabling the account profile switches nothing on implicitly (unless only
  one helmet is in use) — each helmet is enabled on purpose.

## Support revocation (exceptional)

`POST /admin/helmets/:id/revoke-ownership` — `ownership:revoke` (SUPER_ADMIN only), a reason and a
recent admin password confirmation. In one transaction: lock helmet + ownership, close the period
(`REVOKED`, `ADMIN_REVOKED`), cancel any pending transfer, switch the owner's exposure off, move
the helmet to `ACTIVATED` (ownerless → public `UNAVAILABLE`) or `DEACTIVATED`, audit. Sessions are
revoked only when requested (account security affected). The helmet is **not** made claimable:
its PIN is consumed, so re-assignment requires a separate, deliberate process (Phase 4+).
