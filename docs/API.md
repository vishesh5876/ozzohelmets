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

## Public

| Method | Path                       | Notes                                                                                                                                                                                                                             |
| ------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/public/emergency/:token` | No auth. Rate limit `public`. Returns `{ state, helmet: { modelName, brand }, message, profile: null }`. `state` ∈ `NOT_ACTIVATED`, `ACTIVE`, `LOST`, `STOLEN`, `UNAVAILABLE`. Unknown/malformed tokens → 404 `HELMET_NOT_FOUND`. |
| GET    | `/health`                  | DB + Redis readiness.                                                                                                                                                                                                             |

## Planned (Phase 2+)

`/auth` (customer OTP), `/users/me`, `/helmets` (owned), `/activation`, `/emergency-profile`,
`/emergency-contacts`, `/emergency-visibility`, `/ownership-transfers`.
