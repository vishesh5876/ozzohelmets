# RBAC matrix

Roles map to permissions in `packages/types/src/permissions.ts` (`ROLE_PERMISSIONS`); the API
enforces them with `@AdminAuth(Permission.X)` on every admin endpoint (class-level for admin users).
The admin UI only hides what the API would refuse anyway. Generated from the code at the end of
Phase 6 — `src/security/rbac-matrix.spec.ts`, `test/phase5-support.e2e-spec.ts` and
`test/phase6-analytics.e2e-spec.ts` test it.

## Roles × permissions

| Permission                | SUPER_ADMIN | ADMIN | MANUFACTURING | SUPPORT | ANALYTICS_VIEWER |
| ------------------------- | :---------: | :---: | :-----------: | :-----: | :--------------: |
| `dashboard:read`          |      ✓      |   ✓   |       ✓       |    ✓    |        ✓         |
| `models:read`             |      ✓      |   ✓   |       ✓       |    ✓    |        ✓         |
| `models:write`            |      ✓      |   ✓   |       ✓       |    —    |        —         |
| `batches:read`            |      ✓      |   ✓   |       ✓       |    ✓    |        ✓         |
| `batches:write`           |      ✓      |   ✓   |       ✓       |    —    |        —         |
| `batches:generate`        |      ✓      |   ✓   |       ✓       |    —    |        —         |
| `helmets:read`            |      ✓      |   ✓   |       ✓       |    ✓    |        ✓         |
| `helmets:update-status`   |      ✓      |   ✓   |       ✓       |    —    |        —         |
| `labels:read`             |      ✓      |   ✓   |       ✓       |    ✓    |        —         |
| `export:manufacturing`    |      ✓      |   ✓   |       —       |    —    |        —         |
| `audit:read`              |      ✓      |   ✓   |       —       |    —    |        —         |
| `ownership:view`          |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `ownership:revoke`        |      ✓      |   —   |       —       |    —    |        —         |
| `transfer:cancel`         |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `replacement:manage`      |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `helmet-lifecycle:manage` |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `warranty:view`           |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `warranty:manage`         |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `warranty:void`           |      ✓      |   ✓   |       —       |    —    |        —         |
| `warranty:document-view`  |      ✓      |   —   |       —       |    ✓    |        —         |
| `product-report:view`     |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `product-report:manage`   |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `admin-users:manage`      |      ✓      |   —   |       —       |    —    |        —         |
| `customers:read`          |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `customers:manage`        |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `customers:delete`        |      ✓      |   —   |       —       |    —    |        —         |
| `customer-recovery:grant` |      ✓      |   —   |       —       |    —    |        —         |
| `privacy-requests:view`   |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `privacy-requests:manage` |      ✓      |   —   |       —       |    —    |        —         |
| `security-events:view`    |      ✓      |   —   |       —       |    —    |        —         |
| `analytics:view`          |      ✓      |   ✓   |       —       |    ✓    |        ✓         |
| `risk-alert:view`         |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `risk-alert:manage`       |      ✓      |   ✓   |       —       |    ✓    |        —         |
| `qr-integrity:manage`     |      ✓      |   ✓   |       —       |    —    |        —         |

`SUPER_ADMIN_ONLY` = admin-users management, ownership revocation, customer deletion, recovery
grants, privacy-request processing, security events (+ proof-of-purchase documents, which SUPPORT
also holds). ADMIN is "everything except SUPER_ADMIN_ONLY".

## Guarantees (tested)

- MANUFACTURING cannot reach customers, privacy requests, security events or ownership data.
- SUPPORT can search/view customers and suspend/lock/restore/force sign-out, but cannot view
  medical profiles (no admin endpoint returns them), issue recovery grants, delete accounts,
  process privacy requests or view security events.
- ANALYTICS_VIEWER holds no mutating permission: it reads analytics aggregates and helmet QR
  activity, but not risk alerts, and cannot change alerts or QR integrity.
- SUPPORT can view and work risk alerts but cannot change QR integrity (SUPER_ADMIN, ADMIN).
- MANUFACTURING has no analytics, alert or QR integrity permission.
- Analytics responses never contain IPs, IP hashes or user agents; helmet alerts are included in
  the helmet analytics response only for roles with `risk-alert:view`.
- ADMIN cannot use the SUPER_ADMIN-only account recovery and deletion functions.
- No admin endpoint returns decrypted medical data, emergency-contact details, password or
  recovery hashes, refresh tokens or raw IPs, whatever the role.
- Customer tokens never authenticate admin endpoints and vice versa (separate secrets/audiences).

## Endpoint → permission

Authentication endpoints (`/admin/auth/login|refresh|logout`) need no permission;
`/admin/auth/me` and `/admin/auth/reauthenticate` need any authenticated admin.

| Method             | Path                                                | Permission                         |
| ------------------ | --------------------------------------------------- | ---------------------------------- |
| DELETE             | `/admin/customers/:customerId/recovery-grants`      | `CUSTOMER_RECOVERY_GRANT`          |
| DELETE             | `/admin/helmets/:id/transfer`                       | `TRANSFER_CANCEL`                  |
| GET                | `/admin/audit-logs`                                 | `AUDIT_READ`                       |
| GET                | `/admin/batches/:id/export/manufacturing.csv`       | `EXPORT_MANUFACTURING`             |
| GET                | `/admin/batches/:id`                                | `BATCHES_READ`                     |
| GET                | `/admin/batches`                                    | `BATCHES_READ`                     |
| GET                | `/admin/customers/:customerId/security-events`      | `SECURITY_EVENTS_VIEW`             |
| GET                | `/admin/customers/:customerId`                      | `CUSTOMERS_READ`                   |
| GET                | `/admin/customers`                                  | `CUSTOMERS_READ`                   |
| GET                | `/admin/dashboard/operations`                       | `DASHBOARD_READ`                   |
| GET                | `/admin/dashboard`                                  | `DASHBOARD_READ`                   |
| GET                | `/admin/helmet-models/:id`                          | `MODELS_READ`                      |
| GET                | `/admin/helmet-models`                              | `MODELS_READ`                      |
| GET                | `/admin/helmets/:id/barcode`                        | `LABELS_READ`                      |
| GET                | `/admin/helmets/:id/ownership-history`              | `OWNERSHIP_VIEW`                   |
| GET                | `/admin/helmets/:id/qr`                             | `LABELS_READ`                      |
| GET                | `/admin/helmets/:id/transfers`                      | `OWNERSHIP_VIEW`                   |
| GET                | `/admin/helmets/:id`                                | `HELMETS_READ`                     |
| GET                | `/admin/helmets`                                    | `HELMETS_READ`                     |
| GET                | `/admin/privacy-requests`                           | `PRIVACY_REQUESTS_VIEW`            |
| GET                | `/admin/product-reports/:id`                        | `PRODUCT_REPORT_VIEW`              |
| GET                | `/admin/product-reports`                            | `PRODUCT_REPORT_VIEW`              |
| GET                | `/admin/replacements/:helmetId`                     | `HELMETS_READ`                     |
| GET                | `/admin/security-events`                            | `SECURITY_EVENTS_VIEW`             |
| GET                | `/admin/warranties/:id/proof`                       | `WARRANTY_DOCUMENT_VIEW`           |
| GET                | `/admin/warranties/:id`                             | `WARRANTY_VIEW`                    |
| GET                | `/admin/warranties`                                 | `WARRANTY_VIEW`                    |
| PATCH              | `/admin/helmet-models/:id`                          | `MODELS_WRITE`                     |
| PATCH              | `/admin/helmets/:id/status`                         | `HELMETS_UPDATE_STATUS`            |
| PATCH              | `/admin/product-reports/:id`                        | `PRODUCT_REPORT_MANAGE`            |
| PATCH              | `/admin/warranties/:id`                             | `WARRANTY_MANAGE`                  |
| POST               | `/admin/batches/:id/generate`                       | `BATCHES_GENERATE`                 |
| POST               | `/admin/batches/:id/mark-printed`                   | `BATCHES_WRITE`                    |
| POST               | `/admin/batches`                                    | `BATCHES_WRITE`                    |
| POST               | `/admin/customers/:customerId/delete`               | `CUSTOMERS_DELETE`                 |
| POST               | `/admin/customers/:customerId/logout-all`           | `CUSTOMERS_MANAGE`                 |
| POST               | `/admin/customers/:customerId/recovery-grants`      | `CUSTOMER_RECOVERY_GRANT`          |
| POST               | `/admin/customers/:customerId/status`               | `CUSTOMERS_MANAGE`                 |
| POST               | `/admin/helmet-models`                              | `MODELS_WRITE`                     |
| POST               | `/admin/helmets/:id/force-deactivate`               | `HELMET_LIFECYCLE_MANAGE`          |
| POST               | `/admin/helmets/:id/restore-status`                 | `HELMET_LIFECYCLE_MANAGE`          |
| POST               | `/admin/helmets/:id/revoke-ownership`               | `OWNERSHIP_REVOKE`                 |
| POST               | `/admin/privacy-requests/:id/approve`               | `PRIVACY_REQUESTS_MANAGE`          |
| POST               | `/admin/privacy-requests/:id/complete`              | `PRIVACY_REQUESTS_MANAGE`          |
| POST               | `/admin/privacy-requests/:id/reject`                | `PRIVACY_REQUESTS_MANAGE`          |
| POST               | `/admin/replacements`                               | `REPLACEMENT_MANAGE`               |
| POST               | `/admin/warranties/:id/restore`                     | `WARRANTY_VOID`                    |
| POST               | `/admin/warranties/:id/void`                        | `WARRANTY_VOID`                    |
| GET                | `/admin/analytics/overview`                         | `ANALYTICS_VIEW`                   |
| GET                | `/admin/analytics/scans`                            | `ANALYTICS_VIEW`                   |
| GET                | `/admin/analytics/helmets[/:helmetCode[/scans]]`    | `ANALYTICS_VIEW`                   |
| PATCH              | `/admin/analytics/helmets/:helmetCode/qr-integrity` | `QR_INTEGRITY_MANAGE`              |
| GET                | `/admin/risk-alerts[/:id]`                          | `RISK_ALERT_VIEW`                  |
| PATCH              | `/admin/risk-alerts/:id`                            | `RISK_ALERT_MANAGE`                |
| GET / POST / PATCH | `/admin/users[/:id]`                                | `ADMIN_USERS_MANAGE` (class-level) |

## Customer endpoints

Customer endpoints use `@CustomerAuth()`; every query is scoped by the authenticated customer id
and no endpoint accepts a user id from the client. Another customer's helmet, contact, warranty
document, session, deletion request or activity behaves exactly like a missing one (404 / empty).
Covered by `customer-authorization`, `phase5-support` and `warranty` integration suites.
