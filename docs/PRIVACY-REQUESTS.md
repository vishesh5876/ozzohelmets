# Privacy requests

Phase 5 lays the foundation for privacy requests without executing destructive erasure before the
business and legal retention rules are final.

## Data export (customer, self-service)

`GET /customer/account/export` with a recent password confirmation (`X-Recent-Auth`) downloads a
JSON file (`helmet-account-<Customer ID>-<date>.json`):

- account (Customer ID, name, email, verification flag, mobile, status, dates),
- currently owned helmets and the customer's own ownership periods,
- the decrypted emergency profile, emergency contacts and privacy settings,
- warranties (purchase details only where the customer was the registrant),
- the customer's security events (type, device summary, time) and deletion requests.

Never included: password/recovery/refresh-token hashes, recovery codes, IP hashes, internal ids,
admin audit metadata, other owners' data. The export is built from an explicit allow-list
(`customer-account/domain/export.ts`), so new columns can't leak by default. Each export is
audited and recorded as a security event. JSON only (no CSV/PDF yet).

## Account deletion request

Customer (`/customer/account/deletion-request`):

- `POST` with recent authentication and an optional reason → `REQUESTED`;
  one open request at a time (partial unique index);
- `DELETE` cancels while `REQUESTED` or `APPROVED` → `CANCELLED` (audited);
- the Account page explains that helmet, warranty and other required records may be retained or
  anonymised.

State machine (`deletion-policy.ts`): `REQUESTED → APPROVED | REJECTED | CANCELLED`,
`APPROVED → COMPLETED | REJECTED | CANCELLED`; `REJECTED`, `COMPLETED`, `CANCELLED` are terminal.
Transitions use conditional updates, so a customer cancelling and an admin completing at the same
moment can't both win.

## Admin: Privacy requests screen

`GET /admin/privacy-requests` (`privacy-requests:view`: SUPER_ADMIN, ADMIN, SUPPORT) lists
Customer ID, request type, dates, status, reason, reviewer — never emergency or medical content.
Processing is SUPER_ADMIN only (`privacy-requests:manage`): approve, reject, and **complete**
(admin password re-authentication).

## What "complete" (and "mark deleted") does today

No data is erased. In one transaction:

- `users.status = DELETED` (+ when/why); the email is released (the unique index ignores DELETED);
- public emergency sharing switched off (profile disabled, per-helmet switches off, ACTIVE helmets
  back to ACTIVATED) and the public cache invalidated after commit;
- open recovery grants revoked, open deletion requests completed;
- all sessions and recent-auth tokens revoked; audited; security event recorded.

Ownership periods, warranties, status history and audit logs are retained (product safety,
warranty and legal reasons).

## Open decisions (before real erasure)

- Retention periods per record type; which fields to anonymise vs delete (name, mobile, email,
  emergency profile, contacts, photo, security events).
- Whether a deleted owner's helmets should keep an anonymous ownership period or be released.
- Response deadlines and identity checks for requests made outside the app.
