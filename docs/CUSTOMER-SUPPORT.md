# Customer support

Phase 5 gives the support team a way to find a customer and act on their account without ever
seeing their medical information.

## Finding a customer — `Customers` (`customers:read`)

`GET /admin/customers?q=&status=&page=&pageSize=` interprets the search box:

| Input                     | Match                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| `CU-XXXX-XXXX`            | exact Customer ID (checksum-validated; a typo returns nothing)    |
| `HM-XXXX-XXXX`            | exact Helmet ID → its **current** owner                           |
| contains `@`              | partial email (`lower(email_normalized) LIKE %…%`, trigram index) |
| anything else (≥ 3 chars) | partial email **or** name (trigram indexes on both)               |
| empty                     | all customers, newest first                                       |

Results are paginated and carry `customerId, name, email, status, activeHelmets, createdAt,
lastLoginAt` — helmet counts come from one `GROUP BY`, not one query per row. Accounts are always
addressed by Customer ID; internal UUIDs are never shown to support.

Email search exists **only** on authenticated admin endpoints. Public, sign-in, activation and
recovery endpoints stay enumeration-resistant (generic errors, no "this email exists" answers).

## Customer detail (`customers:read`, every view audited as `admin.customer.viewed`)

Shows: Customer ID, email (+ "not verified by design"), mobile (unverified), status (+ when/why it
changed), created, last sign-in, active sessions, owned helmets (status, emergency sharing on/off,
warranty status), ownership history, warranties registered, emergency profile **state**
(configured / enabled / contact count), recovery state (recovery code configured/confirmed, open
grant expiry, last grant use), sign-in blocks in the last 30 days, latest deletion request.

Never shows: password or recovery-code hashes, refresh tokens, medical fields, emergency-contact
names or numbers, raw IPs.

## Actions

| Action                 | Permission                              | Effect                                                                                     |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Suspend                | `customers:manage`                      | `ACTIVE/LOCKED → SUSPENDED`; all sessions revoked at once; sign-in and refresh refused     |
| Lock (security)        | `customers:manage`                      | `ACTIVE/SUSPENDED → LOCKED` (suspected takeover); same effect as suspend                   |
| Restore                | `customers:manage`                      | `SUSPENDED/LOCKED → ACTIVE`                                                                |
| Force sign-out         | `customers:manage`                      | every refresh token and live access token revoked                                          |
| Mark deleted           | `customers:delete` (SUPER_ADMIN)        | irreversible; admin password + reason + Customer ID typed again; see PRIVACY-REQUESTS      |
| Account recovery grant | `customer-recovery:grant` (SUPER_ADMIN) | see [ACCOUNT-RECOVERY](ACCOUNT-RECOVERY.md)                                                |
| Security events        | `security-events:view` (SUPER_ADMIN)    | login successes/blocks, password/email changes, recoveries, grants — no IP, device summary |

Every action requires a reason (stored as an internal note on the account and audited) and is
recorded as a customer security event the customer can see in their activity.

### Suspension and emergency information

Account authentication and QR emergency availability are **separate**. Suspending or locking an
account stops the customer signing in; it does **not** hide the emergency information they chose to
share — a rider in a crash may still need it. Only marking an account deleted switches sharing off.

## Helmet support view

The admin helmet page adds a support summary: activation date, emergency sharing on/off, warranty
status, health flags (`NO_OWNER, ACTIVATED, EMERGENCY_ENABLED, REPORTED_LOST, REPORTED_STOLEN,
DAMAGED, REPLACED, RECALLED, WARRANTY_ACTIVE, HIGH_SCAN_ACTIVITY`) and scan aggregates (last scan,
24 h, 7 d, emergency vs verification scans in 7 d) from one indexed query. No IPs, no locations,
no counterfeit score. `HIGH_SCAN_ACTIVITY` is informational (`HELMET_HIGH_SCAN_THRESHOLD_24H`, 50).
The owner's Customer ID links to the customer page.

## Product reports triage

Reports gain `priority` (LOW/NORMAL/HIGH), an optional assignee, filters (assigned to me /
unassigned) and an internal history (`product_report_events`: status, priority, assignment changes
and internal notes). Internal notes are separate from the reporter's text and never appear in audit
metadata. It is deliberately not a ticketing system.

## Dashboards and audit

- `GET /admin/dashboard/operations`: total/activated/unactivated helmets, active emergency
  profiles, lost/stolen, damaged, active warranties, open product reports, customers, open privacy
  requests, recent activations, and (SUPER_ADMIN only) recent security events.
- Audit log: filters for actor type (admin/customer/system), admin, entity type, exact action,
  date range, Helmet ID and Customer ID (resolved server-side); readable labels; secret-looking
  metadata keys redacted before leaving the API.
