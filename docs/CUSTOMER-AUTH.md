# Customer authentication

There is no OTP, SMS or mobile verification. A customer's identity is **ownership of a helmet**:

- **First activation** creates the account: QR/Helmet ID + Activation PIN (proof of possession) +
  a new password, in one transaction (see [ACTIVATION](ACTIVATION.md)).
- **Sign in** with any Helmet ID the customer currently owns + password.
- **Forgot password**: Helmet ID + the offline recovery code shown once at activation.

Customer auth is completely separate from admin auth: different table (`users`), different JWT
secret (`JWT_CUSTOMER_ACCESS_SECRET`) and audience (`helmet-customer`), different refresh-token
table and cookie. A token of one kind can never authenticate the other (integration-tested).

## Endpoints

```
POST /customer/activation/validate   { publicToken|helmetCode, pin }            → preliminary PIN check (nothing consumed)
POST /customer/activation/register   { publicToken|helmetCode, pin, password, name? }
                                     → account + ownership; access token + refresh cookie + recoveryCode (once)
POST /customer/activation/add-helmet { publicToken|helmetCode, pin } (Bearer)   → helmet added to the signed-in account
POST /customer/auth/login            { helmetCode, password }                    → access token + refresh cookie
POST /customer/auth/recover          { helmetCode, recoveryCode }                → { resetToken, expiresIn } (single use, 10 min)
POST /customer/auth/reset-password   { resetToken, newPassword }                 → all sessions revoked, new recoveryCode (once), signed in
POST /customer/auth/change-password  { currentPassword, newPassword } (Bearer)   → other sessions revoked
POST /customer/auth/recovery-code    { password } (Bearer)                       → new recoveryCode (once); old one stops working
POST /customer/auth/refresh          (cookie + X-Requested-With)                 → rotated cookie + new access token
POST /customer/auth/logout           (cookie + X-Requested-With)                 → this session's token family revoked
POST /customer/auth/logout-all       (Bearer)                                    → every session revoked
GET  /customer/auth/sessions         (Bearer)                                    → active logins (one per token family)
DELETE /customer/auth/sessions/:id   (Bearer)                                    → revoke one of your own sessions
GET|PATCH /customer/auth/me          (Bearer)                                    → profile; name, email, mobile (optional, unverified)
POST /customer/auth/reauthenticate { password } (Bearer) → { recentAuthToken, expiresIn }  for X-Recent-Auth (Phase 3)
```

## Sign-in

`login` order: checksum-validate the Helmet ID (typos rejected before the database) → find the
helmet → its ACTIVE ownership → the user → Argon2id verify the password → user ACTIVE → session.
Unknown helmet, unowned helmet, wrong password and suspended account all return the same
`INVALID_CREDENTIALS` message, and a dummy hash is verified when no user exists so timing is
similar. Because every owned helmet points at the same `users` row, any of them signs in to the
same account; a helmet that has been transferred away (Phase 3) stops working for sign-in.

| Protection    | Limit                                                                                                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route         | `auth` throttler policy (10 req/min/IP, 5-min block)                                                                                                                                                                   |
| Per Helmet ID | every `CUSTOMER_LOGIN_FAILURES_BEFORE_LOCK` (5) failures → temporary lock of `CUSTOMER_LOGIN_LOCKOUT_BASE_SECONDS` × 2^(n−1), capped at `CUSTOMER_LOGIN_LOCKOUT_MAX_SECONDS` (1 h). Never permanent; reset on success. |
| Per IP hash   | `CUSTOMER_LOGIN_MAX_FAILURES_PER_IP_PER_HOUR` (50)                                                                                                                                                                     |
| Audit         | `customer.login.failed` / `customer.login.locked` with IP hash — never the password                                                                                                                                    |

## Passwords

- **Argon2id + server-side pepper** (`CUSTOMER_CREDENTIAL_PEPPER`, separate from `PIN_HASH_PEPPER`).
- **Policy** (NIST SP 800-63B style): at least 8 characters, up to 128, passphrases welcome, **no
  composition rules**. Rejected: common passwords (embedded deny-list), a single repeated
  character, trivial sequences, the helmet's own Helmet ID, and the Activation PIN.
- Changing the password requires the current one and revokes every other session.

## Recovery code

- Format `RK-XXXX-XXXX-XXXX` (12 symbols from the unambiguous alphabet, ~59 bits, CSPRNG).
- Generated at first activation and shown **once**: _"Save this recovery code. It can be used if
  you forget your password."_ The customer must tick "I've saved my recovery code" to continue.
- Stored only as Argon2id + pepper (`users.recovery_code_hash`). Never logged, never in audit
  metadata, never returned again.
- Recovery: `recover` (Helmet ID + code) → single-use reset token (256-bit, SHA-256 key in Redis,
  `RECOVERY_RESET_TOKEN_TTL_SECONDS`, consumed with `GETDEL`) → `reset-password`. The reset
  updates the password **only if the recovery code hash is unchanged** (conditional update), so two
  parallel reset tokens can't both succeed. It then revokes all sessions, rotates the recovery code
  (the old one can never be reused) and returns the new code once.
- A signed-in customer can generate a new code (password required) from Account.
- Heavily rate-limited: every `RECOVERY_FAILURES_BEFORE_LOCK` (3) failures per Helmet ID → escalating
  lock from `RECOVERY_LOCKOUT_BASE_SECONDS` (15 min); `RECOVERY_MAX_FAILURES_PER_IP_PER_HOUR` (10).
  Generic errors. Losing both password and recovery code requires support (flagged).

## Contact details

`email` and `mobile` are optional, **not unique, not verified**, and never used for sign-in or
recovery (`emailVerified`/`mobileVerified` stay `false`). The portal labels them "not verified".

## Tokens and sessions

- **Access token**: HS256 JWT, 15 min (`JWT_CUSTOMER_ACCESS_TTL_SECONDS`), claims `sub`, `typ:
customer`, `sid` (token family = session id). Held in SPA memory only. `CustomerJwtGuard`
  reloads the user on every request, so suspension is immediate.
- **Refresh token**: opaque 256-bit, SHA-256 at rest (`customer_refresh_tokens`), 30-day TTL
  (`CUSTOMER_REFRESH_TTL_DAYS`), httpOnly `SameSite=Strict` cookie `helmet_customer_rt` scoped to
  `/api/v1/customer/auth`, `Secure` in production. Rotated on every use by the shared
  `RefreshTokenRotator` (the same algorithm admin auth uses): presenting an already-rotated token
  outside a 15 s race window revokes the whole family and is audited
  (`customer.refresh.reuse_detected`).
- **CSRF**: cookie endpoints require `X-Requested-With`, which forces a CORS preflight for
  cross-site callers (rejected by the allow-list), on top of SameSite=Strict.

## Portal behaviour

The SPA restores the session with one silent refresh on load, retries a 401 once after a
single-flight refresh (parallel refreshes would trip reuse detection), and never writes tokens to
storage. The `next` parameter after login only accepts same-site relative paths.
