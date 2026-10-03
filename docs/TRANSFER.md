# Ownership transfer

## Flow

```
Current owner                                   Recipient
─────────────                                   ─────────
Helmet → Transfer
  POST /customer/auth/reauthenticate {password} → recentAuthToken (5 min)
  POST /customer/helmets/:id/transfer  (X-Recent-Auth)
    → { transferCode: "TR-K7PX-92LM-QW3E", expiresAt }   shown ONCE
gives Helmet ID + code ───────────────────────► /claim
                                                POST /customer/transfers/preview {helmetCode, transferCode}
                                                then either
                                                  existing: sign in → POST /customer/transfers/claim
                                                  new:      POST /customer/transfers/claim/register
                                                            {helmetCode, transferCode, password, name?}
                                                            → session + recovery code (shown once)
```

Owner may also `GET /customer/helmets/:id/transfer` (pending? until when — never the code) and
`DELETE …/transfer` (cancel). Generating a new code supersedes the previous one.

## The transfer code

| Property    | Value                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------- |
| Format      | `TR-XXXX-XXXX-XXXX`, 12 CSPRNG symbols from the unambiguous 31-symbol alphabet ≈ 59 bits      |
| Bound to    | one helmet (looked up together with the Helmet ID) and the owner who created it               |
| Lifetime    | `TRANSFER_TOKEN_TTL_MINUTES` (default 30); expiry computed from `expires_at`                  |
| Storage     | PostgreSQL `helmet_transfers.code_hash` = HMAC-SHA256(server key, code); never plaintext      |
| Single use  | `PENDING → CLAIMED` in the claim transaction                                                  |
| Invalidated | on claim, owner cancel, support cancel, supersede, or when the helmet leaves ACTIVATED/ACTIVE |
| Logging     | never logged or audited; audit stores only the transfer id                                    |

Why PostgreSQL rather than Redis for the active credential: the claim must be atomic with the
ownership change (same transaction, same row locks). Redis holds the attempt counters and
lockouts. At most one PENDING row per helmet (partial unique index).

## The claim transaction

```
BEGIN
  SELECT helmet … WHERE helmet_code = $1 FOR UPDATE
  SELECT ownership … WHERE helmet_id = $h AND status = 'ACTIVE' FOR UPDATE
  SELECT transfer … WHERE helmet_id = $h AND code_hash = HMAC($code) FOR UPDATE
  verify: exists · PENDING (CLAIMED → TRANSFER_ALREADY_USED) · not expired (→ TRANSFER_CODE_EXPIRED)
          · creator still the current owner · helmet ACTIVATED/ACTIVE · recipient ≠ owner
  [new customer] INSERT users (password + recovery code hashes, prepared before the lock)
  UPDATE old ownership → TRANSFERRED, ended_at, end_reason, transfer_id
  INSERT new ownership (ACTIVE, acquired_via = TRANSFER, transfer_id)
  UPDATE transfer → CLAIMED, to_user_id, claimed_at
  UPDATE helmet_emergency_settings SET enabled = false (previous owner)
  ACTIVE → ACTIVATED (SYSTEM, reason_code TRANSFERRED)   — never ACTIVE after a transfer
  audit helmet.transfer.claimed
COMMIT → invalidate public cache (safety-critical)
```

Two simultaneous claims serialise on the helmet row; the second sees `CLAIMED` and gets
`TRANSFER_ALREADY_USED`. A claim racing a "report stolen" by the owner serialises the same way:
either the claim wins (the old owner's stolen request then gets 404) or stolen wins (the pending
code is cancelled and the claim fails). Both races are integration-tested in loops.

## Restrictions and errors

- Transfer only from ACTIVATED/ACTIVE (`HELMET_NOT_TRANSFERABLE`; `HELMET_REPLACED`).
- `CANNOT_TRANSFER_TO_CURRENT_OWNER` for self-claims.
- Unknown Helmet ID, wrong / cancelled / superseded code → the same `TRANSFER_CODE_INVALID`.
  "Expired" / "already used" are only revealed to someone holding the correct code.

## Abuse protection

| Layer         | Limit                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Route         | `auth` throttle (10/min/IP) on create, preview, claim, claim/register                                                                      |
| Per Helmet ID | every `TRANSFER_FAILURES_BEFORE_LOCK` (5) failures → lock from `TRANSFER_LOCKOUT_BASE_SECONDS` (15 min), doubling, ≤ 24 h, never permanent |
| Per IP hash   | `TRANSFER_MAX_FAILURES_PER_IP_PER_HOUR` (20)                                                                                               |
| Audit         | `helmet.transfer.claim_failed` / `claim_locked` with a hashed helmet reference — never the code                                            |

## Privacy

The previous owner's emergency data disappears on the very next scan (cache invalidated after
commit). The new owner's data appears only after they complete and enable it for this helmet.
The new owner never sees the previous owner's identity or history.
