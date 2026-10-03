# Phase 2 — Customer authentication, helmet activation, emergency profile

Status legend: `[x]` done · `[ ]` pending

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

- [ ] Migration: customer refresh tokens, emergency profiles/contacts/visibility, photo metadata, activation lockout column, constraints
- [ ] Shared types: BloodGroup, Gender, EmergencyProfileStatus, PublicEmergencyState v2, customer/activation/profile contracts, error codes
- [ ] Config: customer JWT, OTP, activation policy, storage, public cache TTL
- [ ] Redis fixed-window limiter service (reused by OTP + activation)
- [ ] Phone normalisation (E.164, libphonenumber-js)
- [ ] Notifications foundation (SMS/email provider interfaces)
- [ ] OTP subsystem (store, providers, limits)
- [ ] Refresh-token rotation core shared by admin + customer
- [ ] Customer auth: OTP login/sign-up, refresh, logout, logout-all, me, sessions
- [ ] CustomerJwtGuard + CurrentCustomer
- [ ] Activation module: validate + atomic complete + lockouts
- [ ] Customer helmets: list, detail, QR
- [ ] File storage (local + S3 placeholder) + profile photo upload
- [ ] Emergency profile (encrypted), contacts (max 5, priorities, reorder), visibility
- [ ] Readiness/completion domain service, enable/disable with status transitions
- [ ] Public emergency v2 + sanitizer + photo endpoint + cache invalidation + scan dedup
- [ ] Admin helmet detail: owner (masked) + emergency profile status

### Frontend

- [ ] Shared API client package used by admin + portal
- [ ] Portal auth (phone → OTP), in-memory access token, silent refresh
- [ ] Activation (QR context + manual Helmet ID with checksum validation)
- [ ] Dashboard, My helmets, helmet detail
- [ ] Onboarding wizard (activated → details → contacts → visibility → review → enable → success)
- [ ] Profile, contacts, privacy, account/sessions pages
- [ ] Lightweight emergency page entry; bundle size before/after documented
- [ ] Admin helmet detail owner/profile status

### Quality

- [ ] Unit + integration tests listed in the brief (incl. concurrency)
- [ ] Playwright end-to-end (admin → activation → profile → public page)
- [ ] Docs: README, ARCHITECTURE, DATABASE, SECURITY, API, HELMET-LIFECYCLE, DEVELOPMENT, CUSTOMER-AUTH, ACTIVATION, EMERGENCY-PROFILE
- [ ] lint · typecheck · tests · build · Docker build
