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

- **Per-helmet exposure (Phase 3).** The profile belongs to the customer; whether a helmet shows
  it is the per-(helmet, user) switch in `helmet_emergency_settings`. A helmet is `ACTIVE` exactly
  when its switch is on (and the profile enabled).
- `POST /customer/emergency-profile/enable {helmetIds?}` → checks readiness (`PROFILE_INCOMPLETE`
  - `missing`), sets the account flag and switches on the given helmets — or, without
    `helmetIds`, the helmet only if exactly one is in use — moving them `ACTIVATED → ACTIVE`.
- `POST /customer/helmets/:id/emergency/enable|disable` → one helmet on/off.
- `POST …/emergency-profile/disable` → clears the flag, turns every switch off and moves owned
  `ACTIVE` helmets back to `ACTIVATED`.
- A transferred-in, newly added or replacement helmet starts with its switch **off**.
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
`showEmergencyContacts` (name, relationship, phone, alternate phone). Contacts are **not verified** (no
OTP/SMS); the public page labels them "Emergency Contact" and states that the information was
provided by the helmet owner and is not verified. Date of birth also yields
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

## Instant loading on poor connections

A bystander scanning the QR may have one bar of 2G. The client-rendered page needed HTML → CSS +
JS → API call before anything useful appeared: several sequential round trips, and nothing at all
without JavaScript. `/e/<token>` is now **one server-rendered response**:

- `GET /api/v1/public/emergency/:token/page` (`PublicEmergencyPageController`) uses the same
  `PublicEmergencyService.resolve` as the JSON endpoint (same filtered DTO, Redis cache, scan
  logging, abuse limits, `public` throttle bucket) and renders the page in
  `page/emergency-page.ts`. Every owner string is HTML-escaped. No product data.
- The stylesheet is inlined (generated from `apps/portal/src/emergency/emergency.css` by
  `scripts/sync-emergency-css.mjs`; a unit test fails on drift), the favicon is `data:`, and there
  are no other requests except the optional owner photo. About 10 KB raw, ~3.5 KB gzipped: it
  arrives in the first TCP round trip.
- Works with JavaScript disabled. A tiny inline script only reveals Copy / Print.
- Strict CSP with hashes (`default-src 'none'`, no `unsafe-inline`), `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.
- Not found → 404, throttled → 429, failure → 503: each still an HTML page with the
  **Call emergency** button. The number is `PUBLIC_EMERGENCY_NUMBER` (default 112; deploys set
  it from `EMERGENCY_NUMBER`, the same value as the portal's `VITE_EMERGENCY_NUMBER`).
- **Fallback:** nginx (`deploy/aapanel/ozzo-portal.conf`, `docker/nginx/spa.conf.template`)
  proxies `/e/<token>` with short timeouts (connect 2 s, read 8 s). On 502/504 it serves the static
  client page `emergency.html`, which retries the API itself. `/verify/` stays client-rendered.

Measured with Chromium network throttling (owner profile with contacts, local servers):

| Network                   | Before (client-rendered) | After (server-rendered) |
| ------------------------- | ------------------------ | ----------------------- |
| Slow 3G (400 ms, 50 KB/s) | ~1.8 s, 7 requests       | ~0.7 s, 1 request       |
| 2G (800 ms, 8 KB/s)       | ~4.3 s, 6 requests       | ~2.3 s, 1 request       |

The 2G figure is uncompressed; with production gzip the page is about a third of that size.

## At the scene: steps, Medical ID, send location, dark mode

The page is built for the stranger who scanned the QR as much as for the paramedic:

- **What to do now** (right under the name): call the emergency number, don't remove the helmet
  unless they aren't breathing, don't move them unless they're in danger, check breathing and keep
  them warm, show this page to the paramedics (`sceneSteps()` in `@helmet/types`). Also shown on
  the "not found" and error pages. _The wording should be reviewed by a medical advisor._
- **Medical ID** card: the blood group as a badge readable at a glance, then allergies (red),
  conditions and medications.
- **Send location** (under the first emergency contact): "SMS my location" / "WhatsApp my
  location". The links already carry the message, so they work without JavaScript; on tap the
  script asks for the bystander's location **in their browser only** (never sent to our server)
  and adds a Google Maps link. Permission denied or no fix within 8 s → the message is sent
  without it. Message: "EMERGENCY: I'm with {name} (scanned their OZZO Safety ID). Please call me
  back. Location: …" (no name when the owner hides it).
- **Permissions-Policy**: every other page keeps `geolocation=()`; only the `/e/` locations use
  `deploy/aapanel/snippets/headers-emergency.conf` / `docker/nginx/security-headers-emergency.conf`
  with `geolocation=(self)`. Without that the browser refuses location silently.
- **Dark mode** follows the phone (`prefers-color-scheme`): warm dark canvas, same tokens; the
  emergency call button stays red with white text. Print is always black on white.

The client fallback page (`apps/portal/src/emergency/main.ts`) renders the same sections.
