# API

Base path **`/api/v1`**. Interactive OpenAPI docs at **`/api/docs`** (JSON:
`/api/docs/openapi.json`) when `SWAGGER_ENABLED=true`.

## Envelope

```json
{ "success": true, "data": { }, "meta": { "page": 1, "pageSize": 25, "total": 100, "totalPages": 4 } }
{ "success": false, "error": { "code": "HELMET_ALREADY_ACTIVATED", "message": "This helmet has already been activated.", "details": null, "requestId": "…" } }
```

`meta` is present on paginated lists. File endpoints (QR, barcode, CSV) return raw bodies.
Stack traces are never returned; send `X-Request-Id` (or read it from `error.requestId`) to
correlate with logs. Error codes are defined in `packages/types/src/api.ts` (`ErrorCode`).

| HTTP    | Typical codes                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400     | `VALIDATION_ERROR` (details = messages), `BAD_REQUEST`                                                                                                                      |
| 401     | `UNAUTHORIZED`, `TOKEN_EXPIRED`, `INVALID_CREDENTIALS`, `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`, `ACCOUNT_DISABLED`                                                 |
| 403     | `FORBIDDEN`                                                                                                                                                                 |
| 404     | `NOT_FOUND`, `HELMET_NOT_FOUND`, `BATCH_NOT_FOUND`, `HELMET_MODEL_NOT_FOUND`                                                                                                |
| 409     | `CONFLICT`, `INVALID_STATUS_TRANSITION`, `BATCH_GENERATION_IN_PROGRESS`, `BATCH_ALREADY_GENERATED`, `BATCH_NOT_GENERATED`, `BATCH_ALREADY_PRINTED`, `HELMET_MODEL_ARCHIVED` |
| 429     | `RATE_LIMITED`, `ACCOUNT_LOCKED`                                                                                                                                            |
| 500/503 | `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE`                                                                                                                                     |

## Authentication (admin)

Send `Authorization: Bearer <accessToken>`. The refresh token is an httpOnly cookie scoped to
`/api/v1/admin/auth`; refresh and logout also require `X-Requested-With: <any>`.

| Method | Path                  | Permission | Notes                                                                                               |
| ------ | --------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| POST   | `/admin/auth/login`   | —          | `{ email, password }` → `{ accessToken, accessTokenExpiresIn, admin }` + cookie. Rate limit `auth`. |
| POST   | `/admin/auth/refresh` | cookie     | Rotates cookie, returns new access token.                                                           |
| POST   | `/admin/auth/logout`  | cookie     | Revokes the token family.                                                                           |
| GET    | `/admin/auth/me`      | any admin  | Profile + effective permissions.                                                                    |

## Admin endpoints

| Method     | Path                                                                                                | Permission                              |
| ---------- | --------------------------------------------------------------------------------------------------- | --------------------------------------- |
| GET        | `/admin/dashboard`                                                                                  | `dashboard:read`                        |
| GET        | `/admin/helmet-models?search&status&page&pageSize`                                                  | `models:read`                           |
| GET        | `/admin/helmet-models/:id`                                                                          | `models:read`                           |
| POST       | `/admin/helmet-models` `{ name, sku, brand, description? }`                                         | `models:write`                          |
| PATCH      | `/admin/helmet-models/:id` `{ name?, brand?, description?, status? }`                               | `models:write`                          |
| GET        | `/admin/batches?search&helmetModelId&generationStatus&page&pageSize`                                | `batches:read`                          |
| GET        | `/admin/batches/:id`                                                                                | `batches:read`                          |
| POST       | `/admin/batches` `{ helmetModelId, manufacturingDate: "YYYY-MM-DD", quantity, batchCode?, notes? }` | `batches:write`                         |
| POST       | `/admin/batches/:id/generate` → **202**; poll `GET /admin/batches/:id`                              | `batches:generate`                      |
| POST       | `/admin/batches/:id/mark-printed` (helmets → PRINTED, PIN escrow purged)                            | `batches:write`                         |
| GET        | `/admin/batches/:id/export/manufacturing.csv` (audited; header `X-Pins-Included`)                   | `export:manufacturing`                  |
| GET        | `/admin/helmets?search&status=A,B&batchId&helmetModelId&activated&page&pageSize`                    | `helmets:read`                          |
| GET        | `/admin/helmets/:id` (detail, QR URL, allowed transitions, history)                                 | `helmets:read`                          |
| PATCH      | `/admin/helmets/:id/status` `{ status, reason? }`                                                   | `helmets:update-status`                 |
| GET        | `/admin/helmets/:id/qr?format=svg\|png`                                                             | `labels:read`                           |
| GET        | `/admin/helmets/:id/barcode?format=svg\|png` (Code128 of Helmet ID)                                 | `labels:read`                           |
| GET        | `/admin/audit-logs?action&entityType&entityId&adminId&page&pageSize`                                | `audit:read`                            |
| GET / POST | `/admin/users`                                                                                      | `admin-users:manage` + role SUPER_ADMIN |
| PATCH      | `/admin/users/:id` `{ name?, role?, status? }`                                                      | `admin-users:manage` + role SUPER_ADMIN |

`search` on helmets accepts a full Helmet ID in any case/spacing (`hm a8f3 kl92`), a prefix, or a
serial number fragment.

### CSV columns

`helmetCode,serialNumber,model,batchCode,qrUrl,activationPin` — `activationPin` is empty once the
batch has been marked printed.

## Customer endpoints

Customer access tokens (`Authorization: Bearer`) come from activation, email + password sign-in (Customer ID / owned Helmet ID also accepted) or a password reset; the refresh cookie is
scoped to `/api/v1/customer/auth`. Every customer endpoint acts only on the authenticated
customer's own data. Details: [CUSTOMER-AUTH](./CUSTOMER-AUTH.md), [ACTIVATION](./ACTIVATION.md),
[EMERGENCY-PROFILE](./EMERGENCY-PROFILE.md).

| Method             | Path                                                                                         | Auth                        | Notes                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST               | `/customer/activation/validate` `{ publicToken \| helmetCode, pin }`                         | —                           | preliminary PIN check, consumes nothing → `{ activatable, helmet{modelName, brand, helmetCode} }`; ineligible/unknown → `HELMET_NOT_ACTIVATABLE`                                                                                             |
| POST               | `/customer/activation/register` `{ publicToken \| helmetCode, pin, email, password, name? }` | —                           | first activation: account (email bound) + ownership atomically; `INVALID_EMAIL` 400, `EMAIL_ALREADY_REGISTERED` 409 (PIN not consumed); → `{ accessToken, accessTokenExpiresIn, customer, helmet, recoveryCode }` + cookie (code shown once) |
| POST               | `/customer/activation/add-helmet` `{ publicToken \| helmetCode, pin }`                       | Bearer                      | existing customer adds a helmet → `{ helmet }`                                                                                                                                                                                               |
| POST               | `/customer/auth/login` `{ identifier, password }`                                            | —                           | email, Customer ID or owned Helmet ID → `{ accessToken, accessTokenExpiresIn, customer }` + cookie; generic `INVALID_CREDENTIALS`                                                                                                            |
| POST               | `/customer/auth/recover` `{ identifier, recoveryCode }`                                      | —                           | → `{ resetToken, expiresIn }` (single use)                                                                                                                                                                                                   |
| POST               | `/customer/auth/reset-password` `{ resetToken, newPassword }`                                | —                           | revokes all sessions, rotates recovery code → login response + `recoveryCode` + cookie                                                                                                                                                       |
| POST               | `/customer/auth/change-password` `{ currentPassword, newPassword }`                          | Bearer                      | revokes other sessions                                                                                                                                                                                                                       |
| POST               | `/customer/auth/recovery-code` `{ password }`                                                | Bearer                      | → `{ recoveryCode }` (old code invalid)                                                                                                                                                                                                      |
| POST               | `/customer/auth/email` `{ currentPassword, newEmail, confirmEmail }`                         | Bearer                      | change sign-in email; unique (409 `EMAIL_ALREADY_REGISTERED`); other sessions revoked; no OTP → profile                                                                                                                                      |
| POST               | `/customer/auth/refresh`                                                                     | cookie + `X-Requested-With` | rotates                                                                                                                                                                                                                                      |
| POST               | `/customer/auth/logout`                                                                      | cookie + `X-Requested-With` | revokes this session                                                                                                                                                                                                                         |
| POST               | `/customer/auth/logout-all`                                                                  | Bearer                      | revokes all sessions                                                                                                                                                                                                                         |
| GET / PATCH        | `/customer/auth/me` `{ name?, mobile? }`                                                     | Bearer                      | profile incl. `email`, `emailVerified` (always false); mobile unverified                                                                                                                                                                     |
| GET                | `/customer/auth/sessions`                                                                    | Bearer                      | one entry per login; `current` flag                                                                                                                                                                                                          |
| DELETE             | `/customer/auth/sessions/:id`                                                                | Bearer                      | own sessions only                                                                                                                                                                                                                            |
| GET                | `/customer/dashboard`                                                                        | Bearer                      | helmets + readiness + contact count                                                                                                                                                                                                          |
| GET                | `/customer/helmets`, `/customer/helmets/:id`                                                 | Bearer                      | owned helmets only (404 otherwise)                                                                                                                                                                                                           |
| GET                | `/customer/helmets/:id/qr`                                                                   | Bearer                      | SVG                                                                                                                                                                                                                                          |
| GET / PUT          | `/customer/emergency-profile`                                                                | Bearer                      | partial update; `null` clears; medical fields encrypted                                                                                                                                                                                      |
| GET                | `/customer/emergency-profile/readiness`                                                      | Bearer                      | `{ status, enabled, canEnable, missing[], completionPercent, steps[] }`                                                                                                                                                                      |
| GET                | `/customer/emergency-profile/preview`                                                        | Bearer                      | exact public projection                                                                                                                                                                                                                      |
| POST               | `/customer/emergency-profile/enable` `{ helmetIds? }` / `disable`                            | Bearer                      | enable: profile on + switch on the given helmets (or the only one in use); disable: everything off, ACTIVE → ACTIVATED                                                                                                                       |
| PUT / GET / DELETE | `/customer/emergency-profile/photo`                                                          | Bearer                      | multipart field `photo`; JPEG/PNG/WebP ≤ 5 MB                                                                                                                                                                                                |
| GET / POST         | `/customer/emergency-contacts`                                                               | Bearer                      | max 5                                                                                                                                                                                                                                        |
| PATCH / DELETE     | `/customer/emergency-contacts/:id`                                                           | Bearer                      | delete = deactivate + re-number                                                                                                                                                                                                              |
| PUT                | `/customer/emergency-contacts/order` `{ ids[] }`                                             | Bearer                      | all active ids, first = priority 1                                                                                                                                                                                                           |
| GET / PUT          | `/customer/emergency-visibility`                                                             | Bearer                      | all 11 flags required; saving = privacy review                                                                                                                                                                                               |

## Public

| Method | Path                                 | Notes                                                                                                                                                                                                                                                                                |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/public/emergency/:token`           | No auth. Rate limit `public`. `state` ∈ `NOT_ACTIVATED`, `ACTIVATED_PROFILE_INCOMPLETE`, `ACTIVE`, `LOST`, `STOLEN`, `DAMAGED`, `REPLACED`, `DEACTIVATED`, `RECALLED`, `UNAVAILABLE`; only `ACTIVE` carries `profile`/`contacts`. Unknown/malformed tokens → 404 `HELMET_NOT_FOUND`. |
| GET    | `/public/emergency/:token/photo`     | Only while the owner's photo is publicly visible.                                                                                                                                                                                                                                    |
| GET    | `/health` (alias of `/health/ready`) | DB + Redis readiness (Phase 7: see below).                                                                                                                                                                                                                                           |

Example (`ACTIVE`, owner shared name, blood group, allergies and contacts):

```json
{
  "success": true,
  "data": {
    "state": "ACTIVE",
    "helmet": { "modelName": "Roadster X1", "brand": "Ozzo", "helmetCode": "HM-A8F3-KL92" },
    "message": "Emergency information and contacts were provided by the helmet owner and are not verified.",
    "profile": {
      "name": "Rahul Sharma",
      "bloodGroup": "O_POSITIVE",
      "bloodGroupLabel": "O+",
      "allergies": ["Penicillin"]
    },
    "contacts": [{ "name": "Rajesh Sharma", "relationship": "Father", "phone": "+919812345678" }]
  }
}
```

Hidden fields are omitted entirely. Phase 1 returned `profile: null` for non-active states; Phase
2 omits the key.

Admin helmet detail (`GET /admin/helmets/:id`) now includes
`owner: { customerId, maskedMobile, since, emergencyProfileStatus } | null`, `pendingTransfer`,
`replacement: { replacedBy, replaces }` and `restoreTarget`.

## Phase 3 — ownership & lifecycle

Sensitive calls need `X-Recent-Auth` from `POST /customer/auth/reauthenticate {password}` (or
`/admin/auth/reauthenticate`) → `{ recentAuthToken, expiresIn }`. Missing/expired →
403 `RECENT_AUTH_REQUIRED`.

| Method       | Path                                                                                | Auth                                    | Notes                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET          | `/customer/helmets`                                                                 | Bearer                                  | each item: `group`, `availableActions`, `emergencyEnabled`, `pendingTransfer`, `replacedBy`, `replaces`, `acquiredVia` |
| GET          | `/customer/helmets/:id`                                                             | Bearer                                  | + `timeline` (this ownership only)                                                                                     |
| POST         | `/customer/helmets/:id/emergency/enable` · `/disable`                               | Bearer                                  | per-helmet exposure switch                                                                                             |
| POST         | `/customer/helmets/:id/transfer`                                                    | Bearer + recent auth                    | → `{ transferCode, expiresAt }` (once; supersedes any previous code)                                                   |
| GET / DELETE | `/customer/helmets/:id/transfer`                                                    | Bearer                                  | `{ pending, expiresAt }` / cancel (404 `TRANSFER_NOT_FOUND`)                                                           |
| POST         | `/customer/transfers/preview` `{ helmetCode, transferCode }`                        | —                                       | → `{ helmet: { helmetCode, modelName, brand } }`                                                                       |
| POST         | `/customer/transfers/claim` `{ helmetCode, transferCode }`                          | Bearer                                  | → `{ helmet }`                                                                                                         |
| POST         | `/customer/transfers/claim/register` `{ …, password, name? }`                       | —                                       | → login response + `recoveryCode` + `helmet`, refresh cookie                                                           |
| POST         | `/customer/helmets/:id/lost` · `/found`                                             | Bearer                                  | → helmet                                                                                                               |
| POST         | `/customer/helmets/:id/stolen` · `/recovered`                                       | Bearer + recent auth                    | → helmet                                                                                                               |
| POST         | `/customer/helmets/:id/damaged` `{ reason?, note? }`                                | Bearer                                  | reason ∈ ACCIDENT, IMPACT, CRACKED, OTHER; note ≤ 200                                                                  |
| POST         | `/customer/helmets/:id/deactivate` `{ confirmHelmetCode }`                          | Bearer + recent auth                    | permanent (support can restore)                                                                                        |
| GET          | `/admin/helmets/:id/ownership-history` · `/transfers`                               | `ownership:view`                        | paginated                                                                                                              |
| DELETE       | `/admin/helmets/:id/transfer`                                                       | `transfer:cancel`                       |                                                                                                                        |
| POST         | `/admin/helmets/:id/restore-status` `{ reason }`                                    | `helmet-lifecycle:manage`               | LOST/STOLEN/DAMAGED/DEACTIVATED → previous safe state                                                                  |
| POST         | `/admin/helmets/:id/force-deactivate` `{ reason }`                                  | `helmet-lifecycle:manage` + recent auth |                                                                                                                        |
| POST         | `/admin/helmets/:id/revoke-ownership` `{ reason, targetStatus, revokeSessions? }`   | `ownership:revoke` + recent auth        | targetStatus ∈ ACTIVATED, DEACTIVATED                                                                                  |
| POST         | `/admin/replacements` `{ originalHelmetId, replacementHelmetCode, reason, notes? }` | `replacement:manage`                    | → `{ replacedBy, replaces }`                                                                                           |
| GET          | `/admin/replacements/:helmetId`                                                     | `helmets:read`                          |                                                                                                                        |

Domain errors: `HELMET_NOT_TRANSFERABLE`, `TRANSFER_CODE_INVALID`, `TRANSFER_CODE_EXPIRED`,
`TRANSFER_ALREADY_USED`, `TRANSFER_ATTEMPTS_EXCEEDED`, `TRANSFER_NOT_FOUND`,
`CANNOT_TRANSFER_TO_CURRENT_OWNER`, `HELMET_ALREADY_LOST`, `HELMET_ALREADY_STOLEN`,
`HELMET_NOT_LOST`, `HELMET_NOT_STOLEN`, `HELMET_NOT_DEACTIVATABLE`, `HELMET_NOT_RECOVERABLE`,
`HELMET_ACTION_NOT_ALLOWED`, `HELMET_REPLACED`, `OWNERSHIP_NOT_FOUND`,
`OWNERSHIP_ALREADY_REVOKED`, `REPLACEMENT_INVALID`, `RECENT_AUTH_REQUIRED`,
`CONFIRMATION_MISMATCH`.

## Phase 4 — Customer ID, warranty, product authenticity

Customer sign-in/recovery take `identifier` (account email, Helmet ID **or** Customer ID `CU-XXXX-XXXX`); the
legacy `helmetCode` field is still accepted. `GET /customer/auth/me` and login responses include
`customer.customerId`; admin helmet detail `owner.customerId` is the Customer ID (never the UUID).
`GET /customer/helmets` items include `warranty: { status, endDate }`.

| Method              | Path                                                                                                                    | Auth                                | Notes                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| GET                 | `/customer/helmets/:id/warranty`                                                                                        | Bearer (current owner)              | effective status, dates, policy, `canRegister`; `details` only for the registrant       |
| POST                | `/customer/helmets/:id/warranty` `{ purchaseDate, purchaseChannel?, sellerName?, sellerCity?, invoiceNumber?, notes? }` | Bearer                              | idempotent for the same purchase date                                                   |
| POST / GET / DELETE | `/customer/helmets/:id/warranty/proof`                                                                                  | Bearer (registrant + current owner) | multipart `proof`; JPEG/PNG/WebP/PDF ≤ 10 MB                                            |
| GET                 | `/admin/warranties?search&status&page&pageSize`                                                                         | `warranty:view`                     | search: Helmet ID, Customer ID, serial, invoice; status = effective                     |
| GET                 | `/admin/warranties/:id`                                                                                                 | `warranty:view`                     | + history                                                                               |
| PATCH               | `/admin/warranties/:id`                                                                                                 | `warranty:manage`                   | `reasonCode` required                                                                   |
| POST                | `/admin/warranties/:id/void` `{ reason, note? }`                                                                        | `warranty:void` + recent auth       |                                                                                         |
| POST                | `/admin/warranties/:id/restore` `{ note? }`                                                                             | `warranty:void`                     |                                                                                         |
| GET                 | `/admin/warranties/:id/proof`                                                                                           | `warranty:document-view`            | audited download                                                                        |
| GET                 | `/public/verify/:token`                                                                                                 | —                                   | `VERIFIED` (safe product facts, lifecycle, warranty, `recallWarning`) or `NOT_VERIFIED` |
| POST                | `/public/product-reports` `{ publicToken?, helmetCode?, reason, description?, contactEmail? }`                          | —                                   | 202; 5/h per IP                                                                         |
| GET                 | `/admin/product-reports?status&page`                                                                                    | `product-report:view`               |                                                                                         |
| PATCH               | `/admin/product-reports/:id` `{ status, note? }`                                                                        | `product-report:manage`             |                                                                                         |

`POST /admin/replacements` accepts `replacementWarrantyEndDate?` (override). Helmet models accept
`warrantyEnabled` and `warrantyMonths` (0–240).

Domain errors: `WARRANTY_NOT_FOUND`, `WARRANTY_ALREADY_REGISTERED`, `WARRANTY_NOT_AVAILABLE`,
`WARRANTY_NOT_REGISTRABLE`, `INVALID_PURCHASE_DATE`, `WARRANTY_INVALID_STATE`,
`WARRANTY_PROOF_NOT_FOUND`, `INVALID_FILE`. Details: [WARRANTY](WARRANTY.md),
[PRODUCT-AUTHENTICITY](PRODUCT-AUTHENTICITY.md).

## Not provided (by decision)

No OTP/SMS/email-verification endpoints and no partner, dealer, distributor, organisation or
inventory endpoints ([ADR-001](ADR-001-no-retail-inventory.md)); an integration test asserts the
OpenAPI document contains none.

## Phase 5 — customer account, support, privacy

Customer (Bearer; scoped to the caller):

| Method              | Path                                       | Notes                                                                                           |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| GET                 | `/customer/dashboard`                      | + `completion`, `health[]`, `security`, `warranty`, `recentActivity[]`                          |
| GET                 | `/customer/account/security`               | recovery-code status, active sessions, password age (no secrets)                                |
| GET                 | `/customer/account/activity?limit=`        | own security events (type, label, device, time)                                                 |
| GET                 | `/customer/account/export`                 | `X-Recent-Auth`; JSON attachment of the customer's own data                                     |
| GET / POST / DELETE | `/customer/account/deletion-request`       | POST needs `X-Recent-Auth` (`{ reason? }`) → 201; DELETE cancels; 409 `DELETION_REQUEST_EXISTS` |
| POST                | `/customer/auth/recovery-code/acknowledge` | "I saved this recovery code"                                                                    |
| POST                | `/customer/auth/sessions/revoke-others`    | sign out every other device                                                                     |
| GET                 | `/customer/auth/sessions`                  | items now `{ id, device, createdAt, lastUsedAt, current }` (no raw user agent)                  |

`POST /customer/auth/recover` also accepts a support Account Recovery Grant (`AR-…`) in
`recoveryCode`.

Admin (permission in brackets — full map in [RBAC-MATRIX](RBAC-MATRIX.md)):

| Method        | Path                                                                                             | Notes                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET           | `/admin/customers?q=&status=&page=&pageSize=`                                                    | [`customers:read`] search; 400 if a partial query is < 3 chars                                                                                   |
| GET           | `/admin/customers/:customerId`                                                                   | [`customers:read`] operational summary; audited                                                                                                  |
| POST          | `/admin/customers/:customerId/status` `{ action: SUSPEND\|LOCK\|RESTORE, reason }`               | [`customers:manage`] 409 `INVALID_STATUS_CHANGE`                                                                                                 |
| POST          | `/admin/customers/:customerId/logout-all` `{ reason }`                                           | [`customers:manage`]                                                                                                                             |
| POST          | `/admin/customers/:customerId/delete` `{ reason, confirmCustomerId }`                            | [`customers:delete`] `X-Recent-Auth`                                                                                                             |
| POST / DELETE | `/admin/customers/:customerId/recovery-grants`                                                   | [`customer-recovery:grant`] POST `{ reason, confirmCustomerId }` + `X-Recent-Auth` → `{ credential, expiresAt }` once; 409 `CUSTOMER_NOT_ACTIVE` |
| GET           | `/admin/customers/:customerId/security-events`, `/admin/security-events`                         | [`security-events:view`]                                                                                                                         |
| GET           | `/admin/privacy-requests?status=`                                                                | [`privacy-requests:view`]                                                                                                                        |
| POST          | `/admin/privacy-requests/:id/approve\|reject\|complete` `{ note? }`                              | [`privacy-requests:manage`]; complete needs `X-Recent-Auth`                                                                                      |
| GET           | `/admin/dashboard/operations`                                                                    | [`dashboard:read`] counters; security events only with `security-events:view`                                                                    |
| GET           | `/admin/product-reports?status=&priority=&assignee=me\|unassigned`, `/admin/product-reports/:id` | detail includes internal `events[]`                                                                                                              |
| PATCH         | `/admin/product-reports/:id` `{ status?, priority?, assignedAdminId?, note?, internalNote? }`    | writes triage events                                                                                                                             |
| GET           | `/admin/audit-logs?actorType=&action=&entityType=&adminId=&helmetCode=&customerId=&from=&to=`    | items add `label`, `actorType`, `customerId`; metadata redacted                                                                                  |

`GET /admin/helmets/:id` adds `support { activatedAt, emergencySharing, warrantyStatus, flags[],
scans }`. Public endpoints may now answer 429 `RATE_LIMITED` to an IP flagged for repeated
unknown-token lookups (cached helmets are still served).

New error codes: `CUSTOMER_NOT_ACTIVE`, `INVALID_STATUS_CHANGE`, `RECOVERY_GRANT_INVALID`,
`DELETION_REQUEST_EXISTS`, `DELETION_REQUEST_NOT_FOUND`, `INVALID_DELETION_TRANSITION`.

## Phase 6 — analytics, risk alerts, QR integrity

Cursor pagination (`?cursor=&limit=`) returns `{ items, nextCursor }`; cursors are opaque.

| Method | Path                                                             | Permission            | Notes                                                                                                                |
| ------ | ---------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET    | `/admin/analytics/overview?range=today\|7d\|30d\|custom&from&to` | `analytics:view`      | rates, period totals, daily series, warranty by model, recent activations                                            |
| GET    | `/admin/analytics/scans?range…`                                  | `analytics:view`      | scan counts, top helmets, invalid-token requests, series                                                             |
| GET    | `/admin/analytics/helmets?minLevel&includeResolved`              | `analytics:view`      | helmets with review signals (cursor, ordered by score)                                                               |
| GET    | `/admin/analytics/helmets/:helmetCode`                           | `analytics:view`      | series, totals, risk + reasons, signals, product reports; `alerts` only with `risk-alert:view`                       |
| GET    | `/admin/analytics/helmets/:helmetCode/scans`                     | `analytics:view`      | scan events (type, time, device category, cache flag) — no IP data (cursor)                                          |
| PATCH  | `/admin/analytics/helmets/:helmetCode/qr-integrity`              | `qr-integrity:manage` | `{ status: NORMAL\|UNDER_REVIEW\|COMPROMISED, note (5–500) }`, audited                                               |
| GET    | `/admin/risk-alerts?status=…\|OPEN_ANY&type`                     | `risk-alert:view`     | cursor, newest activity first                                                                                        |
| GET    | `/admin/risk-alerts/:id`                                         | `risk-alert:view`     |                                                                                                                      |
| PATCH  | `/admin/risk-alerts/:id`                                         | `risk-alert:manage`   | `{ status?, assignedAdminId?, resolutionReason? }`; reason required to resolve/dismiss; 409 on an invalid transition |
| GET    | `/customer/helmets/:id/scan-summary`                             | owner                 | `{ since, emergencyScans30d, verificationScans30d, lastEmergencyScanAt, message }`                                   |

`GET /public/verify/:token` gains an optional `integrityNotice` (only when an admin marked the QR
`COMPROMISED`). The public emergency response is unchanged.

## Phase 7 — operations

| Method | Path                   | Auth                                    | Notes                                                                                                                        |
| ------ | ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health/live`         | public                                  | `{status:"ok"}` whenever the process answers; no dependency checks                                                           |
| GET    | `/health/ready`        | public                                  | `ok` · `degraded` (200, Redis down: emergency pages still served from PostgreSQL) · 503 when PostgreSQL is unreachable (3 s) |
| GET    | `/admin/system/status` | `dashboard:read`                        | `SystemStatusDto`: version, commit, DB/Redis up, worker heartbeats, each job's last run/success/duration/failures (24 h)     |
| GET    | `/internal/metrics`    | `Authorization: Bearer <METRICS_TOKEN>` | Prometheus text. 404 when no token is configured, 401 when wrong; **always 404 through the edge proxy**                      |

Errors caused by an unavailable dependency return `503 SERVICE_UNAVAILABLE` ("Service temporarily
unavailable. Please try again shortly."). Password and PIN checks return `503` "The service is busy"
when the Argon2 queue is full. Clients should retry later. Neither is ever returned for a cached or
database-served public emergency read.

## Planned

Label printing; warranty claims.
