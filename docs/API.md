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

Customer access tokens (`Authorization: Bearer`) come from OTP sign-in; the refresh cookie is
scoped to `/api/v1/customer/auth`. Every customer endpoint acts only on the authenticated
customer's own data. Details: [CUSTOMER-AUTH](./CUSTOMER-AUTH.md), [ACTIVATION](./ACTIVATION.md),
[EMERGENCY-PROFILE](./EMERGENCY-PROFILE.md).

| Method             | Path                                                                 | Auth                        | Notes                                                                                                       |
| ------------------ | -------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| POST               | `/customer/auth/otp/request` `{ mobile }`                            | —                           | → `{ sent, mobile (E.164), expiresIn, resendAfter, devOtp? }` (`devOtp` only with the development provider) |
| POST               | `/customer/auth/otp/verify` `{ mobile, otp }`                        | —                           | → `{ accessToken, accessTokenExpiresIn, customer, isNewCustomer }` + cookie                                 |
| POST               | `/customer/auth/refresh`                                             | cookie + `X-Requested-With` | rotates                                                                                                     |
| POST               | `/customer/auth/logout`                                              | cookie + `X-Requested-With` | revokes this session                                                                                        |
| POST               | `/customer/auth/logout-all`                                          | Bearer                      | revokes all sessions                                                                                        |
| GET / PATCH        | `/customer/auth/me` `{ name? }`                                      | Bearer                      |                                                                                                             |
| GET                | `/customer/auth/sessions`                                            | Bearer                      | one entry per login; `current` flag                                                                         |
| DELETE             | `/customer/auth/sessions/:id`                                        | Bearer                      | own sessions only                                                                                           |
| POST               | `/customer/activation/validate` `{ publicToken \| helmetCode }`      | —                           | → `{ activatable, helmet{modelName, brand, helmetCode} }`; every ineligible case → `HELMET_NOT_ACTIVATABLE` |
| POST               | `/customer/activation/complete` `{ publicToken \| helmetCode, pin }` | Bearer                      | atomic activation → `{ helmet, customer }`                                                                  |
| GET                | `/customer/dashboard`                                                | Bearer                      | helmets + readiness + contact count                                                                         |
| GET                | `/customer/helmets`, `/customer/helmets/:id`                         | Bearer                      | owned helmets only (404 otherwise)                                                                          |
| GET                | `/customer/helmets/:id/qr`                                           | Bearer                      | SVG                                                                                                         |
| GET / PUT          | `/customer/emergency-profile`                                        | Bearer                      | partial update; `null` clears; medical fields encrypted                                                     |
| GET                | `/customer/emergency-profile/readiness`                              | Bearer                      | `{ status, enabled, canEnable, missing[], completionPercent, steps[] }`                                     |
| GET                | `/customer/emergency-profile/preview`                                | Bearer                      | exact public projection                                                                                     |
| POST               | `/customer/emergency-profile/enable` / `disable`                     | Bearer                      | ACTIVATED ⇄ ACTIVE for owned helmets                                                                        |
| PUT / GET / DELETE | `/customer/emergency-profile/photo`                                  | Bearer                      | multipart field `photo`; JPEG/PNG/WebP ≤ 5 MB                                                               |
| GET / POST         | `/customer/emergency-contacts`                                       | Bearer                      | max 5                                                                                                       |
| PATCH / DELETE     | `/customer/emergency-contacts/:id`                                   | Bearer                      | delete = deactivate + re-number                                                                             |
| PUT                | `/customer/emergency-contacts/order` `{ ids[] }`                     | Bearer                      | all active ids, first = priority 1                                                                          |
| GET / PUT          | `/customer/emergency-visibility`                                     | Bearer                      | all 11 flags required; saving = privacy review                                                              |

## Public

| Method | Path                             | Notes                                                                                                                                                                                  |
| ------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/public/emergency/:token`       | No auth. Rate limit `public`. `state` ∈ `NOT_ACTIVATED`, `ACTIVATED_PROFILE_INCOMPLETE`, `ACTIVE`, `LOST`, `STOLEN`, `UNAVAILABLE`. Unknown/malformed tokens → 404 `HELMET_NOT_FOUND`. |
| GET    | `/public/emergency/:token/photo` | Only while the owner's photo is publicly visible.                                                                                                                                      |
| GET    | `/health`                        | DB + Redis readiness.                                                                                                                                                                  |

Example (`ACTIVE`, owner shared name, blood group, allergies and contacts):

```json
{
  "success": true,
  "data": {
    "state": "ACTIVE",
    "helmet": { "modelName": "Roadster X1", "brand": "Ozzo", "helmetCode": "HM-A8F3-KL92" },
    "message": "Emergency information was provided by the helmet owner.",
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
`owner: { maskedMobile, since, emergencyProfileStatus } | null`.

## Planned (Phase 3+)

Ownership transfer, owner lost/stolen reporting, warranty, dealers.
