# Phase 5 — Customer Experience + Admin Operations + Security Hardening

Scope: make the platform useful for real riders and the support team, and close security gaps,
**without** adding dealers, distributors, partners, inventory, payments, SMS/OTP, social login,
service centres, advanced counterfeit scoring or cloud infrastructure.

Surfaces stay: Admin Portal · Customer Portal · public QR / emergency / verification pages →
NestJS API → PostgreSQL + Redis.

## Review findings (start of phase)

| Area              | Finding                                                                                             | Action                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Customer sessions | Revoking a session revoked its refresh tokens, but its 15-min access token kept working.            | `CustomerJwtGuard` now also requires the session (token family) to be live. |
| Session metadata  | Full user-agent strings (≤255 chars) were stored per refresh token.                                 | Store a coarse summary only ("Chrome on Android").                          |
| Account status    | `ACTIVE / SUSPENDED / DELETED` existed; no admin UI/API; no security lock.                          | Add `LOCKED`, admin suspend/lock/restore/force-logout/mark-deleted.         |
| Customer activity | Security-relevant events only in the admin audit log.                                               | New `customer_security_events` table (no raw IP, summarised UA).            |
| Recovery          | Losing password **and** recovery code had no path.                                                  | SUPER_ADMIN-only, single-use, short-lived Account Recovery Grant.           |
| Recovery code ack | Acknowledgement was UI-only.                                                                        | `recovery_code_acknowledged_at` + endpoint; health warning when missing.    |
| Admin RBAC        | Permissions explicit on every endpoint (`@AdminAuth(permission)`); no customer-support permissions. | New customer/privacy/security/recovery permissions + full matrix test.      |
| Public throttling | One per-IP limit (120/min) for all public routes; misses and hits cost the same.                    | Adaptive miss budgets per IP + global burst detection; hits stay cheap.     |
| Product reports   | Status + single resolution note.                                                                    | Priority, optional assignee, internal event/notes history.                  |
| Uploads           | Photos re-encoded with sharp (SVG rejected); PDFs structurally checked; proofs private.             | Reviewed; documented; S3/private bucket remains a deployment task.          |

## Delivered

1. **Customer dashboard**: helmets, emergency-profile status + completion, contacts count, warranty
   summary, security status, recent activity, quick actions, health warnings (safety utility, no
   upsell).
2. **Profile completion**: 8 components (identity, blood group, conditions, allergies,
   medications, emergency contact, privacy review, helmet enablement) → percentage. Eligibility to
   enable is computed separately (`missingRequirements`) and never from the percentage.
3. **Account page**: Account email, Customer ID, sessions (current/others, device summary, created,
   last active; sign out one / others / everywhere), password change, recovery-code status +
   rotation with acknowledgement, account activity, data export, deletion request.
4. **Admin customer support**: search (exact Customer ID / Helmet ID, partial email/name, paginated,
   indexed), customer detail (operational data only — no medical data, contacts, hashes), suspend /
   lock / restore / force logout, SUPER_ADMIN mark-deleted, recovery-code status, security events.
5. **Account Recovery Grant** (SUPER_ADMIN, admin re-auth, reason, typed Customer ID confirmation):
   single-use, short TTL, Argon2id-hashed, shown once, never emailed. Redeemed through the normal
   recovery flow → new password, all sessions revoked, new recovery code shown once.
6. **Privacy**: JSON data export (recent auth), deletion requests (REQUESTED → APPROVED/REJECTED →
   COMPLETED, customer cancel) with an admin Privacy Requests screen; no automatic erasure.
7. **Public emergency page**: emergency information first, large call buttons, copy summary,
   print CSS, clear failure states incl. temporary server failure, accessible markup; product
   identity link secondary.
8. **Abuse controls**: token-shape validation, per-IP miss budget, global miss burst detection,
   higher base limit for real scans; login/activation limits unchanged and separate.
9. **Admin operations**: operational dashboard, helmet support summary (health flags, scan
   aggregates), audit log filters + readable labels + metadata redaction, product report triage.
10. **Docs**: CUSTOMER-SUPPORT, ACCOUNT-RECOVERY, PRIVACY-REQUESTS, RBAC-MATRIX,
    SECURITY-HARDENING (+ updates to the existing docs).

## Decisions taken (flagged for product confirmation)

1. **Suspension does not hide emergency information.** Authentication state and QR availability
   are separate; a suspended or locked rider's approved emergency info keeps working.
2. **Marking an account DELETED** (SUPER_ADMIN, or completing a deletion request) revokes sessions,
   switches off emergency sharing on the owner's helmets and invalidates the public cache.
   Ownership/warranty/audit records are retained (no erasure yet); the email is released.
3. **Recovery grants** require the account to be ACTIVE (restore it first), expire after
   `RECOVERY_GRANT_TTL_MINUTES` (default 60) and replace any earlier open grant.
4. **LOCKED** is an admin security lock (e.g. suspected takeover). Same effect on sign-in as
   SUSPENDED; distinct for reporting. Automatic brute-force lockouts stay temporary (Redis) and
   never change the account status.
5. **Customer data export** is JSON only (no CSV/PDF) and includes the decrypted emergency profile —
   it is the owner's own data, behind recent authentication.

See [CUSTOMER-SUPPORT](CUSTOMER-SUPPORT.md), [ACCOUNT-RECOVERY](ACCOUNT-RECOVERY.md),
[PRIVACY-REQUESTS](PRIVACY-REQUESTS.md), [RBAC-MATRIX](RBAC-MATRIX.md),
[SECURITY-HARDENING](SECURITY-HARDENING.md).

## Verification (end of phase)

| Gate                             | Result                                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests (API)                 | 208 → all passing (25 Phase 5: search parsing, account status, completion, health, deletion state machine, export sanitizer, grant credential/hashing, redaction, summary text, helmet flags, abuse controls, RBAC matrix) |
| Integration (PostgreSQL + Redis) | 161 passing — new `phase5-support` suite (17)                                                                                                                                                                              |
| Playwright                       | 47 passing — Phase 2, 3, 4, customer journey and the new 25-step `phase5-account-support`                                                                                                                                  |
| Emergency page bundle            | 9.9 kB → 11.8 kB raw, 3.8 kB → 4.4 kB gzip (copy/print summary)                                                                                                                                                            |
| Public endpoint                  | cached p50 3.4 ms / p95 5.9 ms locally (200 sequential requests)                                                                                                                                                           |
| Migrations                       | fresh DB, Phase 4/email data snapshot, drift check — see the final report                                                                                                                                                  |

Bugs found and fixed during the phase: revoked sessions kept a valid access token for up to
15 minutes; stored device summaries degraded when re-summarised on read; the recovery-code
acknowledgement raced the status refresh in the portal.

## Technical debt before Phase 6

- Security-event retention runs as an in-process daily timer; move to a scheduled job when the API
  scales horizontally (it is idempotent, so concurrent runs are harmless).
- Admin search uses offset pagination; switch to keyset pagination for very large customer bases.
- The public abuse controls key on IP HMAC only; Phase 6 clone detection should add per-token
  signals (velocity, device fan-out) on top of `helmet_scans`.
- Data export is JSON only; CSV for simple tables if requested.
- Deletion requests stop at "mark deleted"; real erasure/anonymisation awaits retention rules.
