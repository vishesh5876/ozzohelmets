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
5. Phase 2 also deletes a helmet's escrow row the moment its PIN is used.

**Residual risk.** Between generation and printing, someone holding both the database and
`PIN_ESCROW_KEYS` can recover PINs. Mitigations: separate key (not the DB credentials), key in a
secret manager/KMS in production (Phase 7: KMS envelope encryption), short escrow window, export
auditing. A PIN alone is useless without physical access to the helmet's printed Helmet ID and an
OTP-verified mobile number (Phase 2).

**Lost escrow.** If PINs are needed after purge (reprint), Phase 3 adds an audited "re-issue PIN"
action for _unactivated_ helmets: generates a new PIN, replaces the hash, escrows it again.

**Online guessing.** 39.6 bits with Argon2id verification, a per-helmet attempt counter
(`helmets.activation_attempts`, enforced in Phase 2), helmet-code/IP/mobile rate limits and OTP
make brute force impractical.

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

| Permission                                          | SUPER_ADMIN | ADMIN | MANUFACTURING | SUPPORT | ANALYTICS_VIEWER |
| --------------------------------------------------- | :---------: | :---: | :-----------: | :-----: | :--------------: |
| dashboard / models / batches / helmets read         |      ✓      |   ✓   |       ✓       |    ✓    |        ✓         |
| models write, batches write/generate, helmet status |      ✓      |   ✓   |       ✓       |    –    |        –         |
| QR / barcode labels                                 |      ✓      |   ✓   |       ✓       |    ✓    |        –         |
| **export manufacturing CSV (PINs)**                 |      ✓      |   ✓   |       –       |    –    |        –         |
| audit logs                                          |      ✓      |   ✓   |       –       |    –    |        –         |
| admin users                                         |      ✓      |   –   |       –       |    –    |        –         |

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

| Policy    | Default                            | Applied to                                |
| --------- | ---------------------------------- | ----------------------------------------- |
| `default` | 300 / 60 s / IP                    | admin & general API                       |
| `auth`    | 10 / 60 s / IP, then blocked 5 min | login, refresh (Phase 2: OTP, activation) |
| `public`  | 120 / 60 s / IP                    | `GET /public/emergency/:token`            |

The public limit is deliberately lenient (a responder may reload repeatedly; many users can share
a carrier-grade NAT). Phase 2 adds per-helmet-code, per-mobile and per-OTP-attempt limits.

## 9. Logging & audit

- Structured JSON logs (pino). Request/response **bodies are never logged**; auth headers,
  cookies and any field named like a password, PIN, OTP, token or medical attribute are redacted.
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
