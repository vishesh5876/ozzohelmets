# Helmet activation

Activation turns a manufactured helmet into an owned one, wherever it was bought. The concealed
one-time **Activation PIN** shipped with the helmet is the proof of possession: there is no OTP,
SMS, email or mobile verification, and no sale or inventory record is needed
([ADR-001](ADR-001-no-retail-inventory.md)). The PIN is never encoded in the QR and is never used
as the long-term password. The account email is a sign-in identifier, not a proof of ownership.

## Customer flow

First activation (creates the account):

```
scan QR → /e/<token> "Helmet not activated · Ready to activate" → Activate helmet → /activate?t=<token>
  → enter PIN (kept in memory only)
  → POST /customer/activation/validate {publicToken, pin}      preliminary check, consumes nothing
  → account email ("Make sure this email is correct. You will use it to sign in.")
    + create password + confirm (optional name)
  → POST /customer/activation/register {publicToken, pin, email, password, name?}
       one transaction: account (email, Customer ID) + ownership + PIN consumed + escrow purged
       + ACTIVATED + audits
  → recovery code shown ONCE ("Save this recovery code. It can be used if you forget your password.")
  → signed in → onboarding
```

Existing customer adding another helmet (signed in, no new account, no email or password step):

```
/activate?t=<token> (or Helmet ID) → PIN → POST /customer/activation/add-helmet {publicToken|helmetCode, pin}
```

Manual fallback (no camera): `/activate` → "Helmet ID" → client-side checksum validation
(`isValidHelmetCode`) before any request → PIN → email + password.

## Eligibility (single policy)

`ActivationPolicy` (API) applies the one shared list `ACTIVATABLE_STATUSES`
(`packages/types/src/lifecycle.ts`): **`PRINTED`, `IN_INVENTORY`, `SOLD`**. Possession of the PIN
is the purchase proof, so no sale record is required and there is no configuration flag; the
optional admin statuses `IN_INVENTORY`/`SOLD` don't change eligibility. Everything else
(`GENERATED`, `DAMAGED`, `RECALLED`, `DEACTIVATED`, `REPLACED`, …) is refused. The shared
lifecycle table only allows `SYSTEM` to move a helmet to `ACTIVATED`, so no admin or owner can
bypass the flow.

Decision order (`evaluateActivation`, unit-tested):

1. PIN already used, or status ACTIVATED/ACTIVE/LOST/STOLEN → `HELMET_ALREADY_ACTIVATED`
2. An ACTIVE ownership row exists → `HELMET_HAS_OWNER`
3. Status not allowed → `HELMET_NOT_ACTIVATABLE`
4. Helmet locked after repeated wrong PINs → `ACTIVATION_ATTEMPTS_EXCEEDED` (+ `retryAfter`)

## Atomic transaction (`ActivationService.activate`)

```
validate + normalise email, password policy,
hash password + generate recovery code (Argon2id)          -- before the lock, outside the tx
BEGIN
  SELECT … FROM helmets WHERE id = $1 FOR UPDATE          -- serialises concurrent activations
  count ACTIVE helmet_ownerships for the helmet
  evaluate policy (above)                                  -- denial → ROLLBACK, domain error
  argon2id.verify(activation_pin_hash, pin, pepper)
  ── wrong PIN ──────────────────────────────────────────────
  UPDATE helmets SET activation_attempts += 1 [, activation_locked_until]
  audit helmet.activation.failed [+ helmet.activation.locked]   (attempted PIN never recorded)
  COMMIT  → 400 INVALID_ACTIVATION_PIN (or 429 when the lock just started)
  ── correct PIN ────────────────────────────────────────────
  [register]   email free among live accounts? else throw EMAIL_ALREADY_REGISTERED → ROLLBACK
               (PIN not consumed, no account, helmet unchanged)
               INSERT users (email, email_normalized, customer_code, password_hash,
               recovery_code_hash) + audit customer.created
  INSERT helmet_ownerships (helmet, customer, ACTIVE)
  DELETE helmet_activation_secrets WHERE helmet_id = $1    -- escrow purge
  UPDATE helmets SET status='ACTIVATED' WHERE id=$1 AND status=<from>,
         activation_pin_used=true, activated_at=now(), attempts=0, locked_until=NULL
  INSERT helmet_status_history (from → ACTIVATED, SYSTEM, actor=customer)
  audit helmet.activated + helmet.activation_pin.consumed
COMMIT → invalidate public cache → session + recovery code (register) / helmet (add-helmet)
```

`validate` runs the same locked PIN check (failures count towards the lockout) but writes nothing
else, so a correct PIN can be re-checked by `register` without being consumed early. If the
transaction fails, no account exists and the PIN remains unused.

Guarantees:

- **No double activation / PIN replay**: the row lock makes the second request wait; it then sees
  `activation_pin_used = true` and gets `HELMET_ALREADY_ACTIVATED`. Integration test fires two
  registrations for one helmet at the same instant (two different would-be users): exactly one
  succeeds, one ownership row, one user, one history row. Reusing a consumed PIN is refused.
- **No duplicate ownership**: database partial unique index
  `helmet_ownerships(helmet_id) WHERE status='ACTIVE'`; a violation maps to
  `HELMET_ALREADY_ACTIVATED`.
- **No duplicate email**: partial unique index `users_email_normalized_live_key`; two activations
  racing with the same email on different helmets → one succeeds, the other gets
  `EMAIL_ALREADY_REGISTERED` and its PIN stays unused (integration-tested).
- **No partial activation**: all writes in one transaction; `CHECK (NOT activation_pin_used OR
activated_at IS NOT NULL)` backs it up.
- **Optimistic status guard** in `HelmetStatusService.apply` (`WHERE status = from`).

## Brute-force protection

| Layer                 | Limit                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route (`auth` policy) | 10 req/min/IP on validate, register and add-helmet, 5-min block                                                                                                                 |
| Per helmet / token    | every `ACTIVATION_FAILURES_BEFORE_LOCK` (5) wrong PINs locks the helmet for `ACTIVATION_LOCKOUT_BASE_SECONDS` × 2^(n−1) (15 min, 30 min, 1 h … capped at 24 h, never permanent) |
| Per IP hash           | `ACTIVATION_MAX_FAILURES_PER_IP_PER_HOUR` (20) wrong PINs across all helmets                                                                                                    |
| Per customer          | `ACTIVATION_MAX_FAILURES_PER_CUSTOMER_PER_HOUR` (10) for signed-in add-helmet                                                                                                   |
| Audit                 | every failure and lock is audited with the IP hash and attempt count — never the PIN                                                                                            |

The lock is persisted in `helmets.activation_locked_until`, so it applies whether the helmet is
addressed by QR token or by Helmet ID. With ~39.6 bits of PIN entropy and these limits online
guessing is infeasible.

## Enumeration resistance

`validate` returns the same `HELMET_NOT_ACTIVATABLE` (same message) for unknown tokens/codes,
ineligible statuses and already-owned helmets, and never reveals owner information.

## Ownership

`helmet_ownerships` keeps history; activation creates an ACTIVE row. The current owner is
always "the ACTIVE ownership row" — there is no `userId` on `helmets`. Customer helmet endpoints
(`/customer/helmets…`) only return helmets with the caller's ACTIVE ownership; someone else's
helmet is indistinguishable from a missing one (404). Any helmet the customer currently owns can
be used to sign in, next to the account email and Customer ID (see
[CUSTOMER-AUTH](CUSTOMER-AUTH.md)). Transfer is Phase 3.
