# Emergency profile

## Data model

| Table                  | Purpose                                                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emergency_profiles`   | One default profile per customer (`helmet_id IS NULL`; the nullable column reserves per-helmet overrides for later — partial unique indexes enforce one default per user and one override per user+helmet). |
| `emergency_contacts`   | Up to 5 active contacts per customer, `priority` 1…n unique among active contacts (partial unique index), soft-deleted via `is_active`. Phones stored in E.164.                                             |
| `emergency_visibility` | One row per customer; 11 `show_*` flags, all default `false`; `confirmed_at` = explicit privacy review.                                                                                                     |

Fields: name, optional photo, blood group (enum, `UNKNOWN` allowed), date of birth, gender
(enum), allergies / medical conditions / medications (lists), emergency notes, organ donor,
`emergency_profile_enabled`.

## Encryption at rest

`ProfileCipher` uses the platform's AES-256-GCM `DATA_ENCRYPTION_KEYS` keyring (versioned,
first key encrypts, all decrypt). Encrypted columns:

| Field              | Column                          | Format     |
| ------------------ | ------------------------------- | ---------- |
| date of birth      | `date_of_birth_ciphertext`      | text       |
| allergies          | `allergies_ciphertext`          | JSON array |
| medical conditions | `medical_conditions_ciphertext` | JSON array |
| medications        | `medications_ciphertext`        | JSON array |
| emergency notes    | `emergency_notes_ciphertext`    | text       |

Ciphertext format `v1.<iv>.<tag>.<data>`; associated data `emergency_profile:<profileId>:<field>`
binds each value to its row **and** column (moving or swapping ciphertexts fails to decrypt).
Name, blood group, gender and organ donor are stored in plaintext (needed for the public page and
simple status logic; not free text). Decrypted values exist only in request memory: they are not
logged, not audited (audits record changed _field names_ only), not put in URLs and never cached
in raw form.

## Readiness and ACTIVE

`EmergencyReadinessService` (backed by pure functions in `readiness.ts`) defines the minimum to
enable the profile:

1. a name,
2. at least one active emergency contact,
3. an explicit privacy review (visibility saved at least once),

plus the explicit `enable` action. Blood group is optional. `completionPercent` (20 % per step:
activated, details, contacts, privacy, enabled) is a UX hint only — never an authorisation input.

- `POST /customer/emergency-profile/enable` → checks readiness (`PROFILE_INCOMPLETE` + `missing`),
  sets the flag and moves every owned `ACTIVATED` helmet to `ACTIVE` (actor OWNER, history,
  audit) in one transaction.
- `POST …/disable` → clears the flag and moves owned `ACTIVE` helmets back to `ACTIVATED`.
- While enabled, edits that would break a requirement (removing the last contact, clearing the
  name) are rejected with `PROFILE_REQUIREMENT`; a DB CHECK also forbids an enabled profile
  without a name.
- A second helmet activated while the profile is already on stays `ACTIVATED` (no automatic
  ACTIVE after PIN activation) and reports `DISABLED` until the owner switches it on again
  (calling enable is idempotent).

## Visibility & the public data boundary

`buildPublicProfile` is an allow-list: a field is copied into the public response only when its
`show_*` flag is on **and** it has a value. Hidden or empty fields are **omitted** (never `null`),
so a response reveals nothing about what exists. Contacts are included only with
`showEmergencyContacts` (name, relationship, phone, alternate phone). Date of birth also yields
`age`. The photo is exposed as a URL to `/public/emergency/:token/photo`, which serves the image
only while the cached public view says it is visible.

Public profile data is returned only when **all** hold: helmet status is ACTIVE (or DAMAGED /
RECALLED with an owner), an ACTIVE owner exists, the profile is enabled and still meets the
minimum. Otherwise the state is `ACTIVATED_PROFILE_INCOMPLETE`, `NOT_ACTIVATED`, `LOST`,
`STOLEN` or `UNAVAILABLE` with a fixed message and no personal data.

The owner can see exactly what would be public via `GET /customer/emergency-profile/preview`
(same sanitizer).

## Caching

The **already-filtered** public DTO is cached in Redis for `PUBLIC_CACHE_TTL_SECONDS` (30 s).
Every change to the profile, photo, contacts, visibility, enabled flag, ownership or helmet status
invalidates the cache for all helmets the owner holds (`invalidateForOwner`) before the API
responds, so a hidden field disappears on the next scan; the TTL only bounds staleness if an
invalidation is ever missed.

## Photos

`PUT /customer/emergency-profile/photo` (multipart field `photo`): magic-byte sniffing (JPEG, PNG,
WebP only — SVG and everything else rejected), size ≤ `PROFILE_PHOTO_MAX_BYTES` (5 MB),
64–6000 px, full decode with `sharp`, EXIF-orientation applied, **all metadata (including GPS)
stripped**, resized to ≤ 800 px and re-encoded as WebP under a random key
`profile-photos/<uuid>.webp` via `FileStorageService` (`LocalStorageProvider`; `S3StorageProvider`
placeholder). Images are never served directly from storage — only through the owner and public
endpoints that apply authorisation/visibility.

## Scan logging

Unchanged schema (`helmet_scans`: helmet, time, HMAC'd IP, truncated UA, country when behind
Cloudflare, type). New: the same device (IP hash + UA) is logged at most once per helmet per
`SCAN_DEDUP_SECONDS` (60), so refreshes don't drown real scans.
