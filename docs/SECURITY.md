# Security

This document records the security design of the platform and the reasoning behind each
decision. Report vulnerabilities privately to the security owner; never open a public issue.

## 1. Threat model (summary)

| Asset                            | Threats                                                | Primary controls                                                                          |
| -------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Activation PINs                  | DB leak, insider export, online guessing               | Argon2id + pepper, short-lived encrypted escrow, RBAC + audit on export, rate limits      |
| Emergency medical data (Phase 2) | Over-exposure on public page, DB leak, logs            | Owner-controlled visibility (default off), AES-256-GCM field encryption, log redaction    |
| Admin accounts                   | Credential stuffing, token theft, privilege escalation | Argon2id, lockout, short JWTs, rotating refresh tokens with reuse detection, backend RBAC |
| QR tokens                        | Enumeration, cloning                                   | 131-bit random tokens, uniform 404s, scan logging for clone detection                     |
| Availability of emergency page   | Abuse/DoS, over-aggressive limits                      | Lenient per-IP public limit, Redis cache, no CAPTCHA, CDN-cacheable design                |

## 2. Identifier generation

All identifiers use Node's CSPRNG (`crypto.randomBytes`) with **rejection sampling**, so every
symbol is uniformly distributed (no modulo bias). None are derived from database IDs or counters.

| Identifier      | Format                     | Entropy                                 | Secret?      | Notes                                                                                                                                                              |
| --------------- | -------------------------- | --------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Helmet ID       | `HM-XXXX-XXXY`             | 7 × log2(31) ≈ 34.7 bits + check symbol | No (printed) | Unambiguous alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`. Check symbol = weighted sum mod 31 (prime) → detects every single substitution and adjacent transposition. |
| Public QR token | 22 × base62                | ≈ 130.9 bits                            | Bearer-ish   | Only value in the QR URL. Unguessable; enumeration infeasible.                                                                                                     |
| Activation PIN  | 8 symbols, same alphabet   | ≈ 39.6 bits                             | **Yes**      | Never stored in plaintext.                                                                                                                                         |
| Serial number   | `<batchCode>-<000001>`     | —                                       | No           | Manufacturing reference; deliberately sequential within a batch (flagged decision).                                                                                |
| Refresh token   | 32 random bytes, base64url | 256 bits                                | **Yes**      | Stored as SHA-256.                                                                                                                                                 |

Uniqueness is guaranteed by database `UNIQUE` constraints; the generator retries a chunk with
fresh identifiers on collision (expected probability is negligible but handled).

> Why not Luhn mod N? With an odd alphabet size (31) Luhn's "doubling" step is not a bijection,
> so some single-symbol substitutions go undetected. A unit test exhaustively verifies the chosen
> checksum against all substitutions and adjacent transpositions.

## 3. Activation PIN lifecycle — the export decision

**Problem.** PINs must be printed on labels (or inserted on cards), which happens after generation
— possibly days later, possibly more than once (misprints). The spec forbids storing them in
plaintext. Showing them only once in the HTTP response of an asynchronous, possibly-resumed,
5,000-unit job is fragile: a lost download would mean unprintable helmets.

**Decision: short-lived encrypted escrow.**

1. During generation each PIN exists in plaintext only in memory, inside one function.
2. It is immediately (a) hashed with **Argon2id + server-side pepper** (`PIN_HASH_PEPPER`, passed
   as Argon2's `secret`) into `helmets.activation_pin_hash` — the value used for verification
   forever after — and (b) encrypted with **AES-256-GCM** using a _dedicated_ key
   (`PIN_ESCROW_KEYS`) into `helmet_activation_secrets.pin_ciphertext`. The helmet ID is bound as
   GCM associated data, so ciphertexts cannot be swapped between rows.
3. The manufacturing CSV export decrypts escrowed PINs on the fly and streams them; they are never
   logged, cached or written to disk server-side. Export requires `export:manufacturing`
   (SUPER_ADMIN and ADMIN only) and **every export is audited before data is sent** (who, when,
   batch, how many PINs, hashed IP).
4. When the batch is marked **printed**, all escrow rows for the batch are **deleted** in the same
   transaction as the status change (audited as `batch.pin_escrow.purged`). From then on only
   the Argon2 hash exists; exports contain an empty PIN column.
5. Activation deletes the helmet's escrow row in the same transaction that consumes the PIN (Phase 2, implemented).

**Residual risk.** Between generation and printing, someone holding both the database and
`PIN_ESCROW_KEYS` can recover PINs. Mitigations: separate key (not the DB credentials), key in a
restricted env file on the VPS (`/etc/helmet-platform/app.env`, 0640, separate from the DB
credentials, never in backups; see VPS-DEPLOYMENT), short escrow window, export
auditing. The PIN is the proof of possession for first activation, so it is concealed on the
activation card, never encoded in the QR, consumed atomically on use, and can never become the
account password.

**Lost escrow.** If PINs are needed after purge (reprint), Phase 3 adds an audited "re-issue PIN"
action for _unactivated_ helmets: generates a new PIN, replaces the hash, escrows it again.

**Online guessing.** 39.6 bits with Argon2id verification; the PIN is only checked in the
under a row lock with every failure committed; escalating (never permanent) per-helmet lockouts
(`activation_attempts`, `activation_locked_until`), per-customer and per-IP failure budgets and
route throttling make brute force impractical. See `ACTIVATION.md`.

## 4. Admin authentication

- Passwords: Argon2id (m=64 MiB, t=3, p=1). Unknown emails still run a verification against a
  dummy hash to equalise timing; errors are generic (`INVALID_CREDENTIALS`).
- Lockout: after `ADMIN_LOGIN_MAX_ATTEMPTS` failures per email (Redis counter, TTL
  `ADMIN_LOGIN_LOCKOUT_SECONDS`) logins return `ACCOUNT_LOCKED`. The `auth` rate-limit policy
  additionally limits per IP and blocks for 5 windows when exceeded.
- Access token: HS256 JWT, 15 min, audience `helmet-admin`, issuer from env. The guard re-loads
  the admin on each request so disabling/role changes apply immediately.
- Refresh token: opaque 256-bit, stored as SHA-256, `httpOnly; SameSite=Strict; Secure (prod);
Path=/api/v1/admin/auth`. **Rotated on every use** with an atomic claim; tokens form a family —
  presenting an already-rotated token (outside a 15 s race window) is treated as theft and the
  whole family is revoked + audited (`admin.refresh.reuse_detected`).
- CSRF: refresh/logout require an `X-Requested-With` header (forces a CORS preflight, rejected for
  non-allow-listed origins) in addition to SameSite=Strict.
- The SPA holds the access token **in memory only** (never localStorage).
- Disabling an admin or changing their role revokes all their refresh tokens.

## 5. Authorization (RBAC)

Separate `admin_users` table (customers can never be admins). Roles map to permissions in
`@helmet/types` (`ROLE_PERMISSIONS`). Every admin route declares `@AdminAuth(...permissions)`
(optionally `@Roles(...)`), enforced by `AdminJwtGuard` + `RbacGuard` on the server. The admin UI
only hides what the server would reject. Integration tests assert 403s per role.

| Permission                                                           | SUPER_ADMIN | ADMIN | MANUFACTURING | SUPPORT | ANALYTICS_VIEWER |
| -------------------------------------------------------------------- | :---------: | :---: | :-----------: | :-----: | :--------------: |
| dashboard / models / batches / helmets read                          |      ✓      |   ✓   |       ✓       |    ✓    |        ✓         |
| models write, batches write/generate, helmet status                  |      ✓      |   ✓   |       ✓       |    –    |        –         |
| QR / barcode labels                                                  |      ✓      |   ✓   |       ✓       |    ✓    |        –         |
| **export manufacturing CSV (PINs)**                                  |      ✓      |   ✓   |       –       |    –    |        –         |
| audit logs                                                           |      ✓      |   ✓   |       –       |    –    |        –         |
| admin users                                                          |      ✓      |   –   |       –       |    –    |        –         |
| ownership & transfer history (`ownership:view`)                      |      ✓      |   ✓   |       –       |    ✓    |        –         |
| cancel transfer, link replacement, restore / deactivate owned helmet |      ✓      |   ✓   |       –       |    ✓    |        –         |
| **revoke ownership** (`ownership:revoke`)                            |      ✓      |   –   |       –       |    –    |        –         |

Changing a customer-owned helmet through the generic status endpoint additionally requires
`helmet-lifecycle:manage`, and operational statuses (ACTIVATED/ACTIVE) can't be set there at all.

## 6. Cryptography

- `AesGcmCipher`: AES-256-GCM, random 96-bit IV per message, 128-bit tag, optional AAD, versioned
  keyring (`v2:<key>,v1:<key>` — first encrypts, all decrypt) for rotation without downtime.
- Two purpose-separated keyrings: `PIN_ESCROW_KEYS` and `DATA_ENCRYPTION_KEYS` (Phase 2 medical
  fields). Medical columns will store ciphertext; decrypted values are never logged.
- IPs: stored only as HMAC-SHA256 with `IP_HASH_SECRET` (`ip_hash` columns). Raw IPs are never
  persisted.

## 7. Transport, headers, input

- `helmet` security headers; strict CSP on the API (relaxed only when Swagger UI is enabled —
  disable `SWAGGER_ENABLED` in production or protect it at the edge).
- CORS allow-list from `CORS_ORIGINS`, credentials enabled only for those origins.
- `trust proxy` configured via `TRUST_PROXY`; `TRUST_CLOUDFLARE=true` makes `CF-Connecting-IP`
  authoritative (enable only if the origin is reachable exclusively via Cloudflare).
- Global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted`; UUID route params are parsed;
  all public identifiers validated by shape before any lookup.
- CSV exports neutralise spreadsheet formula injection.

## 8. Rate limiting

Redis-backed (atomic Lua fixed window + block) so limits are shared across instances:

| Policy    | Default                            | Applied to                                 |
| --------- | ---------------------------------- | ------------------------------------------ |
| `default` | 300 / 60 s / IP                    | admin & general API, customer refresh      |
| `auth`    | 10 / 60 s / IP, then blocked 5 min | login, admin refresh, recovery, activation |
| `public`  | 120 / 60 s / IP                    | `GET /public/emergency/:token`             |

The public limit is deliberately lenient (a responder may reload repeatedly; many users can share
a carrier-grade NAT). Phase 2 adds per-Helmet-ID escalating lockouts for login, recovery and activation PINs, plus
per-IP failure budgets.

## 9. Logging & audit

- Structured JSON logs (pino). Request/response **bodies are never logged**; auth headers,
  cookies and any field named like a password, PIN, recovery code, token or medical attribute are redacted.
  Query strings are stripped from logged URLs. Prisma query logging is disabled.
- `audit_logs` is append-only (no update/delete endpoints). Audited: admin login success/failure/
  lockout, logout, refresh reuse, admin user changes, model changes, batch create/generation
  start/complete/fail, mark printed, escrow purge, every manufacturing CSV export, helmet status
  changes. Audit metadata never contains secrets.

## 10. Secrets & configuration

- Only `.env.example` is committed (dev placeholders marked `dev-only`). `.env` is git-ignored.
- Startup validation (zod) fails fast and, with `NODE_ENV=production`, **refuses dev-only
  secrets/keys and insecure cookies**.
- Generate production values with `node scripts/generate-secrets.mjs`; store them in a secret
  manager. The seed refuses to run in production.

## 11. Public emergency endpoint

Returns only `{ state, helmet: { modelName, brand }, message }` in Phase 1. Never internal IDs,
Helmet ID, serial, batch, PIN data, owner data or history (asserted by integration tests).
Malformed and unknown tokens return an identical 404 (no oracle). Responses are `no-store` and
`noindex`. Phase 2 will add only the profile fields the owner explicitly made visible.

## 12. Phase 2 — customer realm

Details: [`CUSTOMER-AUTH.md`](./CUSTOMER-AUTH.md), [`ACTIVATION.md`](./ACTIVATION.md),
[`EMERGENCY-PROFILE.md`](./EMERGENCY-PROFILE.md).

- **Separate realms.** Admin and customer tokens use different secrets
  (`JWT_ACCESS_SECRET` ≠ `JWT_CUSTOMER_ACCESS_SECRET`, enforced in production), audiences, refresh
  tables and cookies (`helmet_admin_rt` path `/api/v1/admin/auth`, `helmet_customer_rt` path
  `/api/v1/customer/auth`).
- **Customer authorization.** `CustomerJwtGuard` + `@CurrentCustomer()`; every query is scoped by
  the authenticated user id. No endpoint accepts a user id from the client (extra properties are
  rejected by the global whitelist). Another customer's helmet/contact behaves exactly like a
  missing one (404). Integration tests cover helmets, profile, contacts, visibility and sessions.
- **No OTP/SMS/email verification, no paid auth provider.** Customers authenticate with their
  account email (or Customer ID / an owned Helmet ID) + password. Passwords and recovery codes are
  Argon2id-hashed with `CUSTOMER_CREDENTIAL_PEPPER` (separate from `PIN_HASH_PEPPER`, refused in
  production if dev-only). Generic login/recovery errors ("The email, ID or password is
  incorrect."), dummy verification for unknown identifiers, escalating temporary lockouts per
  typed identifier and per account, and per-IP budgets.
- **Possession vs identity.** Only the one-time activation PIN (or a transfer code issued by the
  current owner) can bind a helmet to an account. The email is an unverified sign-in identifier:
  it is never accepted as proof of ownership, never shown publicly, and never written to audit
  metadata. Email uniqueness is enforced by a partial unique index on the normalised address; an
  email conflict is only revealed after a correct PIN and rolls the activation back without
  consuming the PIN.
- **Email change** requires the current password (counted towards the re-auth lockout) and the
  new address typed twice; it revokes all other sessions and recent-auth tokens and is audited.
- **Recovery code.** `RK-XXXX-XXXX-XXXX` (~59 bits), shown once, stored only as a hash, never
  logged or audited, single use: a reset rotates it and revokes all sessions. Reset tokens are
  256-bit, SHA-256-keyed in Redis, 10-minute TTL, consumed atomically (`GETDEL`).
- **Unverified contact data.** Mobile and emergency contacts are never verified and never used for
  authentication or recovery; the public page says the information was provided by
  the owner and is not verified.
- **Public boundary.** Only `{ state, helmet{modelName, brand[, helmetCode]}, message[, profile,
contacts] }`; profile and contacts only when the helmet is ACTIVE/DAMAGED/RECALLED, owned, and
  the owner's profile is enabled and complete; every field must be switched on and non-empty.
  Never: internal ids, owner mobile/email, PIN data, ownership history, hidden fields (not even as
  `null`). Asserted by unit tests on the sanitizer and integration/Playwright tests on responses.
- **Uploads.** Magic-byte allow-list (JPEG/PNG/WebP), size and dimension limits, full decode and
  re-encode (metadata incl. GPS stripped), random server-side keys with path-traversal-safe
  validation, served only via authorised endpoints with `nosniff`.
- **Audit (no sensitive values):** customer.created/login/login.failed/login.locked/logout/
  sessions.revoked, customer.password.changed/reset, customer.recovery.verified/failed/locked,
  customer.recovery_code.rotated,
  customer.refresh.reuse_detected, helmet.activated, helmet.activation_pin.consumed,
  helmet.activation.failed/locked, emergency_profile.updated (changed field names only) /
  photo.updated / enabled / disabled, emergency_contacts.changed (counts only),
  emergency_visibility.changed (flag names only).
- **Admin visibility.** Admin helmet detail shows a masked owner mobile (if given, labelled unverified), ownership date and
  profile status — never names, contacts or medical data.
- **Emergency page.** Framework-free, renders owner text only via `textContent`; responses are
  `no-store`/`noindex`; `Referrer-Policy: no-referrer` meta on the page.

## 13. Phase 3 — ownership & lifecycle

Details: [`OWNERSHIP.md`](./OWNERSHIP.md), [`TRANSFER.md`](./TRANSFER.md),
[`REPLACEMENT.md`](./REPLACEMENT.md), [`HELMET-LIFECYCLE.md`](./HELMET-LIFECYCLE.md).

- **Recent auth.** Sensitive actions need a password re-check within `RECENT_AUTH_TTL_SECONDS`
  (300): `POST /customer/auth/reauthenticate` or `/admin/auth/reauthenticate` returns a 256-bit
  random token, stored only as a SHA-256 key in Redis with that TTL, bound to the subject (and
  the customer's session), sent as the `X-Recent-Auth` header (never query/body). A per-subject
  generation counter invalidates all outstanding tokens on password change, password reset,
  logout-all and admin-requested session revocation. Wrong passwords use an escalating lockout.
  The portal keeps the token in memory only. Required for: transfer creation, report stolen,
  mark recovered, retire; admin forced deactivation and ownership revocation.
- **Transfer codes.** ~59-bit CSPRNG codes, HMAC-SHA256 at rest (server key, domain separated),
  single use, ≤ 30 min, one PENDING per helmet (DB index), tied to the helmet and the creating
  owner, cancelled on supersede/cancel/status change, never logged or audited. Claims run in one
  row-locked transaction; unknown Helmet IDs and wrong codes are indistinguishable; escalating
  per-Helmet-ID lockouts plus a per-IP budget (`TRANSFER_*`).
- **Old owner's data.** Disappears in the claim transaction (per-helmet switch off, helmet →
  ACTIVATED) and the public cache is purged after commit; the public view checks the current
  owner's switch, so nothing stale can be served from cache or rebuilt for the wrong user.
- **Non-active states never expose data.** Only `ACTIVE` with the current owner's switch on
  returns profile/contacts; lost/stolen/damaged/replaced/deactivated/recalled return a fixed
  message only (unit + integration tested). _Revised in Phase 4 for damaged/recalled — see §14._
- **Authorization.** Lifecycle and transfer endpoints lock the helmet with the caller's ACTIVE
  ownership; other customers' helmets behave as missing (404). Support actions are each behind
  their own permission; destructive ones require the admin password again.
- **Audit (no secrets):** `helmet.transfer.created|cancelled|claimed|claim_failed|claim_locked`,
  `helmet.lifecycle.lost|found|stolen|recovered|damaged|deactivated|restored`,
  `helmet.ownership.revoked`, `helmet.replacement.linked`, `helmet.emergency.enabled|disabled`,
  `customer.recent_auth.created|failed`, `admin.recent_auth.created|failed`. Never transfer codes,
  passwords, recovery codes or medical values; owner damage notes live only in status history.

## 14. Phase 4 — Customer ID, warranty, product authenticity

Details: [`CUSTOMER-AUTH.md`](./CUSTOMER-AUTH.md#customer-id-phase-4), [`WARRANTY.md`](./WARRANTY.md),
[`PRODUCT-AUTHENTICITY.md`](./PRODUCT-AUTHENTICITY.md).

- **Customer ID is an identifier, not a credential.** CSPRNG, checksummed, unique, immutable,
  not derived from the UUID. Sign-in still needs the password (or recovery code). Unknown IDs and
  wrong passwords return the same message; lockouts count per typed identifier **and** per
  resolved account, so alternating Helmet ID / Customer ID gains no extra attempts.
- **Phase 3 rule revised:** DAMAGED / RECALLED helmets return the owner-approved fields only if
  that helmet was already sharing (per-helmet switch on, profile enabled and complete) — no new
  exposure is ever created by a status change — and always with a warning. LOST, STOLEN,
  REPLACED, DEACTIVATED return nothing personal.
- **Proof of purchase** is untrusted input: size-limited before parsing, type decided by magic
  bytes, images decoded and re-encoded (metadata/GPS stripped, pixel bomb limit), PDFs rejected if
  they contain JavaScript, launch actions, embedded files or rich media. Stored under random keys,
  never public or cached, downloaded only as `attachment` with `nosniff` and `default-src 'none'`
  CSP. Visible to the registrant while they own the helmet and to `warranty:document-view`
  holders (SUPER_ADMIN, SUPPORT — not ADMIN), every admin view audited.
- **Transfer privacy:** later owners see coverage dates and status only; the previous owner's
  purchase details and document are filtered server-side (not just hidden in the UI).
- **Public verification** returns an allow-listed DTO (no owner, Customer ID, UUIDs, serial, PIN
  material, purchase data); unknown and malformed tokens get one indistinguishable response and are
  not cached. Wording never asserts physical authenticity or counterfeiting.
- **Product reports** are anonymous, rate-limited (5/h per hashed IP + throttler), sanitized
  (control characters stripped, length-limited, rendered as text), never public, and their
  description/email never reach audit metadata or logs.
- **Warranty integrity:** one warranty per helmet (unique index + row locks), dates computed only on
  the server, append-only history, no delete, reason codes required for corrections, void needs a
  recent admin password confirmation.
- **Audit (no secrets or documents):** `warranty.registered|updated|voided|restored|proof_uploaded|proof_viewed|proof_removed`,
  `product_report.created|status_changed`; `customer.created` carries the Customer ID.

## 15. Phase 5 — support, privacy & hardening

Summary (details in [SECURITY-HARDENING](SECURITY-HARDENING.md), [ACCOUNT-RECOVERY](ACCOUNT-RECOVERY.md),
[PRIVACY-REQUESTS](PRIVACY-REQUESTS.md), [RBAC-MATRIX](RBAC-MATRIX.md)):

- Session revocation is immediate (Redis marker per token family checked by `CustomerJwtGuard`).
- Only a "Browser on OS" summary is stored per session/security event; security events never hold
  raw IPs or secrets; retention is configurable.
- Suspension/lock block sign-in and revoke sessions but leave emergency QR information available.
- The last-resort Account Recovery Grant is SUPER_ADMIN-only, re-authenticated, confirmed, hashed,
  single-use, short-lived, audited and never emailed.
- Admin views use Customer IDs and never return medical data, contact details, hashes or tokens;
  customer views are audited; audit metadata is redacted by key.
- Public QR abuse controls count only misses (unknown/malformed tokens) per IP HMAC with a global
  burst mode; cached emergency pages keep being served; no CAPTCHA.

## 16. Phase 6 — analytics & abuse detection

Summary (details in [QR-ABUSE-DETECTION](QR-ABUSE-DETECTION.md), [RISK-ENGINE](RISK-ENGINE.md),
[ANALYTICS](ANALYTICS.md), [DATA-RETENTION](DATA-RETENTION.md)):

- **Privacy:** no precise location, no raw IPs (HMAC only), no fingerprinting (no canvas/audio/
  WebGL), scans store a coarse device category and "Browser on OS" summary instead of the raw UA,
  no query strings, **no medical data** in any analytics or risk computation.
- **No identities in admin analytics:** responses never contain IPs, IP hashes or user agents;
  source-level alerts carry an opaque, non-reversible `sourceRef`; attempted tokens are never stored.
- **Availability first:** analytics never disables emergency pages; cached helmets are always
  served; no CAPTCHA; risk and QR integrity never change lifecycle status.
- **Non-accusatory output:** "Suspicious scan activity", "Possible copied QR", "Review recommended";
  nothing is labelled counterfeit, fake or fraud. Customers are not notified automatically and see
  only neutral counts.
- **RBAC:** `analytics:view`, `risk-alert:view`, `risk-alert:manage`, `qr-integrity:manage`
  ([RBAC-MATRIX](RBAC-MATRIX.md)); alert transitions and QR integrity changes are audited, individual
  scans are not.
- **Client IP integrity:** production rejects `TRUST_PROXY=true` and (by default) a missing trusted
  proxy; forwarded headers arriving while untrusted are logged ([DEPLOYMENT](DEPLOYMENT.md)).
- **Retention:** scan detail 180 days, aggregates kept; ownership, warranty, manufacturing and
  audit history are never removed by retention.

## 17. Phase 7 — production on a VPS

Summary (details in [PHASE-7](PHASE-7.md), [VPS-DEPLOYMENT](VPS-DEPLOYMENT.md),
[DATA-INVENTORY](DATA-INVENTORY.md)):

- **Exposure:** only the edge publishes 80/443. PostgreSQL, Redis, API and worker are on an
  internal network. UFW allows 22/80/443 only. Optional origin lock to Cloudflare ranges. Unknown
  hosts are closed (444). Internal metrics return 404 at the edge.
- **Client IP:** Cloudflare `CF-Connecting-IP` honoured only from Cloudflare ranges; the edge
  overwrites `X-Forwarded-For`; the API trusts only the edge subnet. Spoofing was tested.
- **Headers:** HSTS (edge); CSP per app; strict CSP on `/e/` and `/verify/` (`default-src 'none'`
  for the API); `nosniff`, `X-Frame-Options DENY`, COOP, Permissions-Policy. The browser check
  found no violations.
- **Containers:** non-root api/worker/SPAs, read-only root filesystems, `cap_drop: ALL`,
  `no-new-privileges`, resource limits, minimal images.
- **Secrets:** restricted env files only (none in the repository or compose YAML). Startup
  refuses dev, weak, reused or shared secrets, wildcard or HTTP CORS, non-HTTPS QR URLs and
  Swagger without opt-in. Keyrings must be backed up offline (not in backups).
- **Availability vs. abuse:** valid emergency reads are never login-throttled. Redis down → public
  reads fail open from PostgreSQL, auth fails closed (503). Argon2 work is capped so login floods
  cannot slow emergency pages.
- **Uploads:** symlink-safe atomic local storage (0600/0700), served only through authorised API
  routes. Optional ClamAV scan for warranty PDFs, failing closed.
- **Logs:** no IPs at the edge, QR tokens masked, extended redaction. Audited across 1,330 log
  lines with zero sensitive values found.
- **Dependencies:** audit reduced to 0 critical; the remaining findings are dev-only or the Prisma
  CLI (see PHASE-7).
