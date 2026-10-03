# Helmet activation

Activation turns an unsold-to-owned helmet into an owned one: it binds the helmet to a verified
customer, consumes the one-time PIN and moves the helmet to `ACTIVATED`.

## Customer flow

```
scan QR → /e/<token> "Helmet not activated" → Activate helmet → /activate?t=<token>
  → POST /customer/activation/validate {publicToken}     (no auth, no PIN)
  → enter PIN (kept in memory only)
  → mobile → OTP → signed in (skipped when already signed in)
  → POST /customer/activation/complete {publicToken, pin} (authenticated)
  → success → onboarding
```

Manual fallback (no camera): `/activate` → "Helmet ID" → client-side checksum validation
(`isValidHelmetCode`) before any request → `validate {helmetCode}` → PIN → OTP → complete.

## Eligibility (single policy)

`ActivationPolicy` (API) is the only place that decides which statuses may be activated:
`SOLD` always; `IN_INVENTORY` only while `ACTIVATION_ALLOW_IN_INVENTORY=true` (temporary
allowance for retail channels that don't record sales). Everything else is refused. The shared
lifecycle table only allows `SYSTEM` to move a helmet to `ACTIVATED`, so no admin or owner can
bypass the flow.

Decision order (`evaluateActivation`, unit-tested):

1. PIN already used, or status ACTIVATED/ACTIVE/LOST/STOLEN → `HELMET_ALREADY_ACTIVATED`
2. An ACTIVE ownership row exists → `HELMET_HAS_OWNER`
3. Status not allowed → `HELMET_NOT_ACTIVATABLE`
4. Helmet locked after repeated wrong PINs → `ACTIVATION_ATTEMPTS_EXCEEDED` (+ `retryAfter`)

## Atomic transaction (`ActivationService.complete`)

```
BEGIN
  SELECT … FROM helmets WHERE id = $1 FOR UPDATE          -- serialises concurrent activations
  count ACTIVE helmet_ownerships for the helmet
  evaluate policy (above)                                  -- denial → ROLLBACK, domain error
  argon2id.verify(activation_pin_hash, pin, pepper)
  ── wrong PIN ──────────────────────────────────────────────
  UPDATE helmets SET activation_attempts += 1 [, activation_locked_until]
  audit helmet.activation.failed [+ helmet.activation.locked]
  COMMIT  → 400 INVALID_ACTIVATION_PIN (or 429 when the lock just started)
  ── correct PIN ────────────────────────────────────────────
  INSERT helmet_ownerships (helmet, customer, ACTIVE)
  DELETE helmet_activation_secrets WHERE helmet_id = $1    -- escrow purge
  UPDATE helmets SET status='ACTIVATED' WHERE id=$1 AND status=<from>,
         activation_pin_used=true, activated_at=now(), attempts=0, locked_until=NULL
  INSERT helmet_status_history (from → ACTIVATED, SYSTEM, actor=customer)
  audit helmet.activated + helmet.activation_pin.consumed
COMMIT → invalidate public cache → 200 { helmet, customer }
```

Guarantees:

- **No double activation / PIN replay**: the row lock makes the second request wait; it then sees
  `activation_pin_used = true` and gets `HELMET_ALREADY_ACTIVATED`. Integration test fires two
  activations for one helmet at the same instant: exactly one 200, one 409, one ownership row,
  one history row.
- **No duplicate ownership**: database partial unique index
  `helmet_ownerships(helmet_id) WHERE status='ACTIVE'`; a violation maps to
  `HELMET_ALREADY_ACTIVATED`.
- **No partial activation**: all writes in one transaction; `CHECK (NOT activation_pin_used OR
activated_at IS NOT NULL)` backs it up.
- **Optimistic status guard** in `HelmetStatusService.apply` (`WHERE status = from`).

## Brute-force protection

| Layer                 | Limit                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route (`auth` policy) | 10 req/min/IP on validate and complete, 5-min block                                                                                                                                                            |
| Validate              | 60/hour per IP (domain limiter)                                                                                                                                                                                |
| Per helmet            | every `ACTIVATION_FAILURES_BEFORE_LOCK` (5) wrong PINs locks the helmet for `ACTIVATION_LOCKOUT_BASE_SECONDS` × 2^(n−1) (15 min, 30 min, 1 h … capped at 24 h); persisted in `helmets.activation_locked_until` |
| Per customer          | `ACTIVATION_MAX_FAILURES_PER_CUSTOMER_PER_HOUR` (10) wrong PINs across all helmets                                                                                                                             |
| Per IP                | `ACTIVATION_MAX_FAILURES_PER_IP_PER_HOUR` (20)                                                                                                                                                                 |
| PIN check             | only in the authenticated call, i.e. behind OTP-verified sign-in                                                                                                                                               |

With ~39.6 bits of PIN entropy this makes online guessing infeasible.

## Enumeration resistance

`validate` returns the same `HELMET_NOT_ACTIVATABLE` (same message) for unknown tokens/codes,
ineligible statuses and already-owned helmets, and never reveals owner information.
`complete` can reveal `HELMET_ALREADY_ACTIVATED` only to an OTP-verified, rate-limited customer.

## Ownership

`helmet_ownerships` keeps history; Phase 2 creates the first ACTIVE row. The current owner is
always "the ACTIVE ownership row" — there is no `userId` on `helmets`. Customer helmet endpoints
(`/customer/helmets…`) only return helmets with the caller's ACTIVE ownership; someone else's
helmet is indistinguishable from a missing one (404). Transfer is Phase 3.
