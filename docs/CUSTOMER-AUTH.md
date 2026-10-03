# Customer authentication

Customers sign in with their mobile number and a one-time code. Customer auth is completely
separate from admin auth: different table (`users`), different JWT secret
(`JWT_CUSTOMER_ACCESS_SECRET`) and audience (`helmet-customer`), different refresh-token table
and cookie. A token of one kind can never authenticate the other (integration-tested).

## Lifecycle

```
POST /customer/auth/otp/request  { mobile }        → code sent (same response whether or not an account exists)
POST /customer/auth/otp/verify   { mobile, otp }   → account found or created, access token + refresh cookie
POST /customer/auth/refresh      (cookie + X-Requested-With) → rotated cookie + new access token
POST /customer/auth/logout       (cookie + X-Requested-With) → this session's token family revoked
POST /customer/auth/logout-all   (Bearer)          → every session revoked
GET  /customer/auth/sessions     (Bearer)          → active logins (one per token family), current marked
DELETE /customer/auth/sessions/:id (Bearer)        → revoke one of your own sessions
GET|PATCH /customer/auth/me      (Bearer)          → profile / account name
```

- **Accounts are created only after OTP verification** — requesting a code never creates or
  reveals an account (no enumeration). `isNewCustomer` is returned only after the code proves
  possession of the number. Concurrent first logins for the same number resolve to one account
  (unique `users.mobile` + retry).
- **Phone numbers** are normalised to E.164 with `libphonenumber-js`; numbers without a country
  code use `DEFAULT_PHONE_REGION` (default `IN`). Invalid numbers → `INVALID_PHONE_NUMBER`.
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

## OTP subsystem

| Property         | Value / mechanism                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Code             | 6 digits from `crypto.randomInt` (uniform)                                                                              |
| Storage          | Redis only: `otp:code:login:<HMAC(mobile)>` → `{ hash: HMAC-SHA256(OTP_HASH_SECRET, purpose:mobile:code), attempts }`   |
| TTL              | `OTP_TTL_SECONDS` (300) via Redis expiry                                                                                |
| Single use       | deleted on success                                                                                                      |
| Attempts         | `OTP_MAX_ATTEMPTS` (5); counted atomically in a Lua script; the code is burned when exhausted (`OTP_TOO_MANY_ATTEMPTS`) |
| Re-issue         | a new code overwrites (invalidates) the previous one                                                                    |
| Resend cooldown  | `OTP_RESEND_COOLDOWN_SECONDS` (60) per number                                                                           |
| Per-number limit | `OTP_MAX_PER_MOBILE_PER_HOUR` (5)                                                                                       |
| Per-IP limit     | `OTP_MAX_PER_IP_PER_HOUR` (20), keyed by the HMAC'd client IP                                                           |
| Global limit     | `OTP_GLOBAL_MAX_PER_MINUTE` (300) — protects SMS spend during abuse                                                     |
| Route limit      | `auth` throttler policy (10/min/IP, 5-min block) on request/verify                                                      |

Neither phone numbers nor codes appear in Redis keys or values in plaintext, and codes are never
logged. Delivery goes through `OtpProvider`:

- `DevelopmentOtpProvider` (`OTP_PROVIDER=development`) — logs only a masked number and returns
  the code in the API response field `devOtp` so local development and automated tests work.
  **Environment validation refuses this provider when `NODE_ENV=production`.**
- `SmsOtpProvider` (`OTP_PROVIDER=sms`, default) — sends through `NotificationService` →
  `SmsNotificationProvider`. The bound provider is currently an explicit "unconfigured"
  placeholder that fails with `OTP_DELIVERY_FAILED` (503) until an SMS vendor is chosen (flagged).

## Portal behaviour

The SPA restores the session with one silent refresh on load, retries a 401 once after a
single-flight refresh (parallel refreshes would trip reuse detection), and never writes tokens to
storage. The `next` parameter after login only accepts same-site relative paths.
