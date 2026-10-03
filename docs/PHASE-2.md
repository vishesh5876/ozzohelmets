# Phase 2 — Customer authentication, helmet activation, emergency profile

Status: **complete**. Legend: `[x]` done · `[ ]` pending

## Target flow

Helmet generated → printed → SOLD (or IN_INVENTORY when temporarily allowed) → customer scans QR →
"not activated" → Activate → PIN (proof of possession) → create password → atomic activation
(account, ownership, PIN consumed, escrow purged, ACTIVATED) → recovery code shown once →
emergency details → contacts → visibility →
review → enable → ACTIVE → anonymous scan shows only approved fields → visibility change reflected
→ disable hides everything. Later: sign in with any owned Helmet ID + password; forgot password
→ Helmet ID + recovery code.

> **Product change (October 2026):** OTP/SMS authentication was removed entirely. There is no OTP
> login, SMS provider, mobile verification or OTP storage. The Activation PIN proves possession at
> first activation; afterwards customers use Helmet ID + password, with an offline recovery code.

## Design decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Activation eligibility is one policy (`ActivationPolicy`): `SOLD` always; `IN_INVENTORY` only when `ACTIVATION_ALLOW_IN_INVENTORY=true`. `PRINTED → ACTIVATED` edge removed from the lifecycle table.                                                                                                                                                                                                                                                                                                                                                   |
| 2   | Customer auth is separate from admin auth: own JWT secret + audience, own refresh-token table and cookie (`helmet_customer_rt`, path `/api/v1/customer/auth`). Rotation/reuse-detection algorithm extracted into a shared core used by both.                                                                                                                                                                                                                                                                                                            |
| 3   | Customer identity = helmet ownership. Login = any currently owned Helmet ID (checksum-validated) + password; generic errors; escalating temporary per-helmet lockouts + per-IP budget. Passwords: Argon2id + `CUSTOMER_CREDENTIAL_PEPPER`, min 8, passphrases, no composition rules, common/weak rejected. Recovery: `RK-XXXX-XXXX-XXXX` shown once, stored hashed, single use, rotated on every reset; reset revokes all sessions. Email/mobile optional, non-unique, unverified, never used for auth or recovery.                                     |
| 4   | Activation: PIN pre-checked by `validate` under a row lock (failures count), then re-verified inside the `register` / `add-helmet` transaction: row lock (`FOR UPDATE`), eligibility, no active owner, PIN unused, Argon2 verify, [new user with password + recovery-code hashes] + ownership + PIN consumed + escrow purge + status + history + audit in one transaction. Failed attempts are committed and drive escalating per-helmet lockouts (never permanent) plus per-IP/per-customer budgets. Partial unique index guarantees one active owner. |
| 5   | Unauthenticated `validate` returns the same `HELMET_NOT_ACTIVATABLE` for every ineligible helmet (no ownership enumeration).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | Emergency profile belongs to the customer (`helmet_id` nullable for future per-helmet overrides). Allergies, conditions, medications, notes and date of birth are AES-256-GCM encrypted with field+row-bound AAD.                                                                                                                                                                                                                                                                                                                                       |
| 7   | Visibility defaults: everything off. Privacy review is an explicit confirmation (`confirmed_at`).                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 8   | `ACTIVE` requires: name, ≥1 active contact, privacy confirmed, profile enabled (blood group optional). Enforced by `EmergencyReadinessService`. Enabling moves owned `ACTIVATED` helmets to `ACTIVE`; disabling moves them back (`ACTIVE → ACTIVATED` edge added for OWNER/SYSTEM). While enabled, edits that would break a requirement are rejected.                                                                                                                                                                                                   |
| 9   | Public data is shown only when helmet is ACTIVE/DAMAGED/RECALLED **and** has an owner **and** profile is enabled. Hidden fields are omitted (not null). The filtered DTO is cached 30 s and invalidated on every owner change.                                                                                                                                                                                                                                                                                                                          |
| 10  | Emergency page becomes a dedicated vanilla-TS Vite entry (no React) served for `/e/*`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 11  | Profile photos: magic-byte check, decoded and re-encoded by `sharp` (strips EXIF/GPS), max 5 MB / 4096 px, stored via `FileStorageService` (local provider; S3 placeholder). Served through API endpoints only.                                                                                                                                                                                                                                                                                                                                         |
| 12  | Scan logging dedups the same device (IP hash + UA) per helmet for 60 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Checklist

### Backend

- [x] Migration: customer refresh tokens, emergency profiles/contacts/visibility, photo metadata, activation lockout column, constraints
- [x] Shared types: BloodGroup, Gender, EmergencyProfileStatus, PublicEmergencyState v2, customer/activation/profile contracts, error codes
- [x] Config: customer JWT, credential pepper, login/recovery lockouts, activation policy, storage, public cache TTL
- [x] Redis fixed-window limiter + escalating `LockoutService` (login, recovery, activation)
- [x] Password policy (length, deny-list, no Helmet ID / PIN) and recovery codes (generate, hash, normalise)
- [x] OTP/SMS architecture removed (modules, providers, env vars, endpoints, screens, tests)
- [x] Refresh-token rotation core shared by admin + customer
- [x] Customer auth: Helmet ID + password login, recover, reset-password, change-password, recovery-code rotation, refresh, logout, logout-all, me, sessions
- [x] CustomerJwtGuard + CurrentCustomer
- [x] Activation module: validate + atomic register (first account) + add-helmet + lockouts
- [x] Customer helmets: list, detail, QR
- [x] File storage (local + S3 placeholder) + profile photo upload
- [x] Emergency profile (encrypted), contacts (max 5, priorities, reorder), visibility
- [x] Readiness/completion domain service, enable/disable with status transitions
- [x] Public emergency v2 + sanitizer + photo endpoint + cache invalidation + scan dedup
- [x] Admin helmet detail: owner (masked) + emergency profile status

### Frontend

- [x] Shared API client package used by admin + portal
- [x] Portal auth (Helmet ID + password, recovery flow), in-memory access token, silent refresh
- [x] Activation (QR context + manual Helmet ID with checksum validation) → password → recovery code shown once; Add helmet for signed-in owners
- [x] Dashboard, My helmets, helmet detail
- [x] Onboarding wizard (activated → details → contacts → visibility → review → enable → success)
- [x] Profile, contacts, privacy, account (unverified contact details, change password, new recovery code, sessions) pages
- [x] Lightweight emergency page entry; bundle size before/after documented
- [x] Admin helmet detail owner/profile status

### Quality

- [x] Unit + integration tests listed in the brief (incl. concurrency)
- [x] Playwright end-to-end (admin → activation → profile → public page)
- [x] Docs: README, ARCHITECTURE, DATABASE, SECURITY, API, HELMET-LIFECYCLE, DEVELOPMENT, CUSTOMER-AUTH, ACTIVATION, EMERGENCY-PROFILE
- [x] lint · typecheck · tests · build · Docker build

## Results

### Emergency page bundle (production build)

|                                     | JS (raw / gzip)                                                         | CSS (raw / gzip) | Framework            |
| ----------------------------------- | ----------------------------------------------------------------------- | ---------------- | -------------------- |
| Before (Phase 1 React route)        | 268.8 kB / 86.4 kB (react chunk 260.6 kB + route 5.0 kB + entry 3.2 kB) | 14.3 kB / 3.9 kB | React + React Router |
| After (standalone `emergency.html`) | 5.9 kB / 2.6 kB (page 5.1 kB + modulepreload polyfill 0.8 kB)           | 3.3 kB / 1.3 kB  | none                 |

≈ 46× less JavaScript on the safety-critical path.

### Verification

| Check                                                               | Result                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm format:check` | pass                                                                                                                                                                                                                                                                               |
| API unit tests                                                      | 153 passed (21 suites; Phase 1: 86)                                                                                                                                                                                                                                                |
| API integration tests (PostgreSQL + Redis)                          | 73 passed (9 suites; Phase 1: 26) — incl. password login, multi-helmet login, lockouts, recovery, concurrent activation, PIN reuse                                                                                                                                                 |
| Playwright end-to-end                                               | 10/10 tests (generate → PIN export → QR → activate with PIN + password → recovery code once → profile → contacts → visibility → enable/ACTIVE → logout → Helmet ID + password login → public page → recovery → old password/code rejected → hide field → disable)                  |
| Docker                                                              | API, portal and admin images rebuilt after the auth change. API container applied 3 migrations, passed health, password login returns the generic error, OTP routes are gone (404). Portal nginx serves SPA routes (`/recover`) from `index.html` and `/e/*` from `emergency.html` |

### Migrations

`20261003093118_phase2_customer_activation_profile`, `20261003144957_phase2_password_auth_recovery`
(drops unique email/mobile, adds `password_changed_at`, `recovery_code_hash`, `recovery_code_created_at`). Not yet applied to the external database
(the build sandbox cannot reach it) — apply with `prisma migrate deploy` (see DATABASE.md).

## Business decisions still open

1. **Lost password _and_ recovery code**: the customer cannot self-recover; support needs a
   manual identity process (Phase 3 admin support tools).
2. **Retail flow for SOLD**: with `ACTIVATION_ALLOW_IN_INVENTORY=false`, someone must mark helmets
   SOLD before customers can activate (admin today; dealer scanning is Phase 5). Turn the allowance
   on temporarily if retail sales are not recorded yet.
3. **Lost/stolen public behaviour**: decided in Phase 3 — status message only, no owner data.
4. **Emergency number** shown on the public page (`VITE_EMERGENCY_NUMBER`, default 112) — per
   market?
5. **Recalled helmets**: emergency profile still shown (safety first); a separate recall notice
   on the public page is not shown yet.

## Deferred to Phase 3 (intentional)

- Ownership transfer (codes in Redis, new owner claims with the transfer code, previous owner's data never carried
  over), owner-initiated lost/stolen, admin support tools (ownership history, PIN re-issue).
- Per-helmet emergency profile overrides (schema ready: `emergency_profiles.helmet_id`).
- S3 storage provider implementation; photo storage is local-disk (volume) for now.
- Server-side / edge rendering of the emergency page HTML (current page is already ~6 kB JS).
- Scan notifications, anti-counterfeit analytics (Phase 6).
