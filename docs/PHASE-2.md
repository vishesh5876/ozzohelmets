# Phase 2 — Customer authentication, helmet activation, emergency profile

Status: **complete**. Legend: `[x]` done · `[ ]` pending

## Target flow

Helmet generated → printed → SOLD (or IN_INVENTORY when temporarily allowed) → customer scans QR →
"not activated" → Activate → PIN → mobile → OTP → account created/identified → atomic activation
(ownership, PIN consumed, escrow purged, ACTIVATED) → emergency details → contacts → visibility →
review → enable → ACTIVE → anonymous scan shows only approved fields → visibility change reflected
→ disable hides everything.

## Design decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Activation eligibility is one policy (`ActivationPolicy`): `SOLD` always; `IN_INVENTORY` only when `ACTIVATION_ALLOW_IN_INVENTORY=true`. `PRINTED → ACTIVATED` edge removed from the lifecycle table.                                                                                                                                                                                                                                |
| 2   | Customer auth is separate from admin auth: own JWT secret + audience, own refresh-token table and cookie (`helmet_customer_rt`, path `/api/v1/customer/auth`). Rotation/reuse-detection algorithm extracted into a shared core used by both.                                                                                                                                                                                         |
| 3   | OTP: 6 digits via `crypto.randomInt`, HMAC-SHA256 hashed, Redis-only, TTL 5 min, single use, 5 attempts (atomic Lua), new OTP replaces old, 60 s resend cooldown, per-mobile / per-IP / global limits. Redis keys use HMAC(mobile), never raw numbers. Dev provider returns the code in the API response **only** when `OTP_PROVIDER=development` (rejected in production).                                                          |
| 4   | Activation: PIN is verified only in the authenticated `complete` call (so unauthenticated callers can't test PINs). Row lock (`FOR UPDATE`), eligibility, no active owner, PIN unused, Argon2 verify, ownership + PIN consumed + escrow purge + status + history + audit in one transaction. Failed attempts are committed and drive progressive per-helmet lockouts. The existing partial unique index guarantees one active owner. |
| 5   | Unauthenticated `validate` returns the same `HELMET_NOT_ACTIVATABLE` for every ineligible helmet (no ownership enumeration).                                                                                                                                                                                                                                                                                                         |
| 6   | Emergency profile belongs to the customer (`helmet_id` nullable for future per-helmet overrides). Allergies, conditions, medications, notes and date of birth are AES-256-GCM encrypted with field+row-bound AAD.                                                                                                                                                                                                                    |
| 7   | Visibility defaults: everything off. Privacy review is an explicit confirmation (`confirmed_at`).                                                                                                                                                                                                                                                                                                                                    |
| 8   | `ACTIVE` requires: name, ≥1 active contact, privacy confirmed, profile enabled (blood group optional). Enforced by `EmergencyReadinessService`. Enabling moves owned `ACTIVATED` helmets to `ACTIVE`; disabling moves them back (`ACTIVE → ACTIVATED` edge added for OWNER/SYSTEM). While enabled, edits that would break a requirement are rejected.                                                                                |
| 9   | Public data is shown only when helmet is ACTIVE/DAMAGED/RECALLED **and** has an owner **and** profile is enabled. Hidden fields are omitted (not null). The filtered DTO is cached 30 s and invalidated on every owner change.                                                                                                                                                                                                       |
| 10  | Emergency page becomes a dedicated vanilla-TS Vite entry (no React) served for `/e/*`.                                                                                                                                                                                                                                                                                                                                               |
| 11  | Profile photos: magic-byte check, decoded and re-encoded by `sharp` (strips EXIF/GPS), max 5 MB / 4096 px, stored via `FileStorageService` (local provider; S3 placeholder). Served through API endpoints only.                                                                                                                                                                                                                      |
| 12  | Scan logging dedups the same device (IP hash + UA) per helmet for 60 s.                                                                                                                                                                                                                                                                                                                                                              |

## Checklist

### Backend

- [x] Migration: customer refresh tokens, emergency profiles/contacts/visibility, photo metadata, activation lockout column, constraints
- [x] Shared types: BloodGroup, Gender, EmergencyProfileStatus, PublicEmergencyState v2, customer/activation/profile contracts, error codes
- [x] Config: customer JWT, OTP, activation policy, storage, public cache TTL
- [x] Redis fixed-window limiter service (reused by OTP + activation)
- [x] Phone normalisation (E.164, libphonenumber-js)
- [x] Notifications foundation (SMS/email provider interfaces)
- [x] OTP subsystem (store, providers, limits)
- [x] Refresh-token rotation core shared by admin + customer
- [x] Customer auth: OTP login/sign-up, refresh, logout, logout-all, me, sessions
- [x] CustomerJwtGuard + CurrentCustomer
- [x] Activation module: validate + atomic complete + lockouts
- [x] Customer helmets: list, detail, QR
- [x] File storage (local + S3 placeholder) + profile photo upload
- [x] Emergency profile (encrypted), contacts (max 5, priorities, reorder), visibility
- [x] Readiness/completion domain service, enable/disable with status transitions
- [x] Public emergency v2 + sanitizer + photo endpoint + cache invalidation + scan dedup
- [x] Admin helmet detail: owner (masked) + emergency profile status

### Frontend

- [x] Shared API client package used by admin + portal
- [x] Portal auth (phone → OTP), in-memory access token, silent refresh
- [x] Activation (QR context + manual Helmet ID with checksum validation)
- [x] Dashboard, My helmets, helmet detail
- [x] Onboarding wizard (activated → details → contacts → visibility → review → enable → success)
- [x] Profile, contacts, privacy, account/sessions pages
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

| Check                                                               | Result                                                                                                                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm format:check` | pass                                                                                                                                                                                                 |
| API unit tests                                                      | 150 passed (21 suites; Phase 1: 86)                                                                                                                                                                  |
| API integration tests (PostgreSQL + Redis)                          | 60 passed (8 suites; Phase 1: 26)                                                                                                                                                                    |
| Playwright end-to-end                                               | 7/7 steps passed                                                                                                                                                                                     |
| Docker                                                              | API + portal images built; container applied the Phase 2 migration, passed health, OTP sign-in and photo upload (sharp in the slim image); nginx served `/e/*` → `emergency.html` and proxied `/api` |

### Migrations

`20261003093118_phase2_customer_activation_profile`. Not yet applied to the external database
(the build sandbox cannot reach it) — apply with `prisma migrate deploy` (see DATABASE.md).

## Business decisions still open

1. **SMS provider** (MSG91, Twilio, AWS SNS …, plus Indian DLT template registration). Until bound,
   production OTP delivery fails closed with `OTP_DELIVERY_FAILED`.
2. **Retail flow for SOLD**: with `ACTIVATION_ALLOW_IN_INVENTORY=false`, someone must mark helmets
   SOLD before customers can activate (admin today; dealer scanning is Phase 5). Turn the allowance
   on temporarily if retail sales are not recorded yet.
3. **Lost/stolen public behaviour**: currently a status message only, no owner data (Phase 3).
4. **Emergency number** shown on the public page (`VITE_EMERGENCY_NUMBER`, default 112) — per
   market?
5. **Recalled helmets**: emergency profile still shown (safety first); a separate recall notice
   on the public page is not shown yet.

## Deferred to Phase 3 (intentional)

- Ownership transfer (codes in Redis, new-owner OTP claim, previous owner's data never carried
  over), owner-initiated lost/stolen, admin support tools (ownership history, PIN re-issue).
- Per-helmet emergency profile overrides (schema ready: `emergency_profiles.helmet_id`).
- S3 storage provider implementation; photo storage is local-disk (volume) for now.
- Email + password customer login (schema supports `users.email`/`password_hash`).
- Server-side / edge rendering of the emergency page HTML (current page is already ~6 kB JS).
- Scan notifications, anti-counterfeit analytics (Phase 6).
