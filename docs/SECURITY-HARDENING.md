# Security hardening (Phase 5)

Review performed at the start of Phase 5; each item lists what was checked and what changed.

## Sessions

- **Immediate revocation.** Revoking a session previously revoked its refresh tokens only; its
  15-minute access token kept working. Now every revocation (single session, other sessions,
  everywhere, password change/reset, email change, suspension/lock, force sign-out, deletion,
  refresh-token reuse) writes a short-lived Redis marker per token family
  (`customer-session-revoked:<familyId>`, TTL = access-token lifetime) that `CustomerJwtGuard`
  checks on every request. A marker (not a DB lookup) avoids races with refresh rotation.
- **Safe session ids.** Sessions are identified by the refresh-token _family_ id (a random UUID),
  never a token or token hash. Customers can only revoke their own (others → 404).
- **Minimal device data.** Only a coarse "Browser on OS" summary is stored for new refresh tokens
  and security events (`summarizeUserAgent`); no full user-agent strings, versions or device models.
  Older rows are summarised on read.

## Authentication & recovery

- Login lockouts count per typed identifier **and** per resolved account, so switching between
  email, Customer ID and Helmet ID never resets them (tested). Lockouts escalate but are temporary
  (capped); external brute force can't permanently deny an account. Per-IP budgets add a third layer.
- Password change: current password required, policy enforced, other sessions and recent-auth
  tokens revoked, audited without the password.
- Email change: current password + typed-twice confirmation, normalised uniqueness, other sessions
  revoked, audited without addresses. No OTP.
- Recovery codes: status only ("Configured"), rotation requires the password, acknowledgement is
  recorded, the old code dies immediately. Support can never retrieve one.
- Last-resort recovery grant: SUPER_ADMIN only, re-auth + reason + typed confirmation, hashed,
  single use, short TTL, audited — see [ACCOUNT-RECOVERY](ACCOUNT-RECOVERY.md).

## Activation (reviewed, unchanged + tests added)

Per-helmet escalating PIN lockouts and per-IP/per-customer budgets; lockouts temporary; a
successful activation resets attempts and lock; a taken email never consumes the PIN; concurrent
activations are serialised by the row lock; the PIN never appears in audit logs or security events;
PIN escrow is deleted on activation. New test: `phase5-support` › activation security review.

## Public QR pages

- Emergency access must stay available, so limits target only **misses** (malformed or unknown
  tokens): `PUBLIC_MISS_LIMIT_PER_IP` per `PUBLIC_MISS_WINDOW_SECONDS` flags an IP; a flagged IP is
  still served cached helmets and gets `PUBLIC_UNCACHED_LIMIT_WHEN_FLAGGED` uncached lookups per
  window (shared/CGNAT addresses), then 429. A global miss burst
  (`PUBLIC_GLOBAL_MISS_LIMIT_PER_MINUTE`) tightens per-IP budgets to a quarter. No CAPTCHA.
- Token-shape validation happens before cache or DB; IPs are only seen as keyed HMACs.
- The base public limit was raised (120 → 300/min/IP) because real scans are cheap cache hits.
- Failure states never reveal whether a hidden account exists (unknown, malformed and
  rate-limited responses carry no owner information).

## Data minimisation in admin views

- Admin customer views use Customer IDs, never internal UUIDs; no medical data, contact details,
  hashes or tokens are returned. Viewing a customer is audited.
- Audit metadata is redacted by key (`password|secret|token|hash|pin|recovery code|credential|
cipher|email`) before leaving the API — defence in depth, writers already avoid secrets.
- Security events store no raw IP and no secrets; admins see type, Customer ID, device summary.

## Medical data encryption (audited)

Allergies, conditions, medications, notes and date of birth are AES-256-GCM encrypted per field
with key versioning (`DATA_ENCRYPTION_KEYS`; ciphertext `v1.<iv>.<tag>.<data>`), AAD bound to profile id + field;
no plaintext DB columns (DB-level inspection tests in `emergency-profile`); never logged, audited
or returned in errors; the public projection is an allow-list; exports decrypt only for the owner.
Admin endpoints never decrypt.

## Uploads (reviewed)

- Profile photos: JPEG/PNG/WebP only by magic bytes (SVG refused), size-limited, re-encoded with
  sharp (metadata stripped), random storage keys, served with `nosniff` and `no-store`.
- Warranty proofs: PDF structural checks (no JavaScript/embedded files/launch actions), images
  re-encoded, private storage, owner/permitted-admin download only.
- Local disk storage remains for development; private object storage (S3 with block public
  access, SSE-KMS) is a **production deployment task** (Phase 7). The storage abstraction already
  has an S3 provider.

## Errors

Public and authentication errors stay generic; admin APIs return precise operational codes
(`INVALID_STATUS_CHANGE`, `CUSTOMER_NOT_ACTIVE`, `CONFIRMATION_MISMATCH`…). The global exception
filter never returns stack traces outside development.

## Public cache invalidation (regression-tested)

Profile, contacts, visibility, per-helmet enable/disable, transfer, lost/found, stolen/recovered,
damage, replacement, deactivation, support restore and account deletion all invalidate the cached
public view; `phase5-support` › public cache invalidation checks the next scan reflects each change.

## Phase 6 additions

- **Trusted proxy enforcement** (`env.schema.ts`): in production `TRUST_PROXY=true` is rejected
  and a missing proxy configuration fails startup unless `REQUIRE_TRUSTED_PROXY_IN_PRODUCTION=false`
  (direct exposure). `request-meta.middleware.ts` logs `ClientIp` errors (rate-limited) when
  `X-Forwarded-For` / `CF-Connecting-IP` arrive while untrusted. Unit-tested in `env.schema.spec.ts`.
- **Raw user agents no longer stored** on new scan rows (summary + device category only).
- **Token enumeration** and **valid-token scraping** raise deduplicated alerts; scraping sources are
  rationed and, far above the limit, refused for uncached lookups — cached emergency pages stay
  available ([QR-ABUSE-DETECTION](QR-ABUSE-DETECTION.md)).
- **Background work moved out of the API**: the security-event purge now runs in the worker.
- Tests: no IP hashes in analytics responses, no raw IP in `helmet_scans`, viewer cannot mutate,
  MANUFACTURING has no analytics, emergency page available under HIGH risk and COMPROMISED QR.
