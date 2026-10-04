# Account recovery

## 1. Normal recovery (self-service, no mailbox needed)

`/recover`: email, Customer ID or owned Helmet ID **+ recovery code** (`RK-XXXX-XXXX-XXXX`) →
single-use reset token → new password. All sessions are revoked, the recovery code is replaced and
the new code is shown once (acknowledgement recorded). Details: [CUSTOMER-AUTH](CUSTOMER-AUTH.md).

A signed-in customer can generate a new recovery code (current password required); the old code
stops working immediately. The Account page shows only _"Recovery code: Configured"_ (or
_Missing_ / _not confirmed as saved_) — the plaintext is never shown again and nobody, including
support, can retrieve it.

## 2. Last resort: Account Recovery Grant (SUPER_ADMIN only)

For a customer who lost **both** password and recovery code.

### Support procedure (manual, before using the tool)

1. Verify identity out of band — e.g. a call back to a number on file, proof of purchase showing
   the Helmet ID, photo of the helmet label, details only the owner knows. Two independent factors.
2. Escalate to a SUPER_ADMIN with the evidence. Regular SUPPORT and ADMIN roles cannot issue grants.
3. The SUPER_ADMIN issues the grant and reads it to the customer by phone or hands it over in
   person. **Never email it**, never paste it into tickets or chat.

### What the tool enforces

`POST /admin/customers/:customerId/recovery-grants` (`customer-recovery:grant`):

- admin password re-authentication (`X-Recent-Auth`), a reason (≥ 10 chars), and the Customer ID
  typed again (`confirmCustomerId`);
- the account must be `ACTIVE` (restore a suspended/locked account first);
- credential `AR-XXXX-XXXX-XXXX-XXXX` (16 CSPRNG symbols ≈ 79 bits), returned **once**; only a
  peppered Argon2id hash is stored (`account_recovery_grants.credential_hash`);
- short TTL: `RECOVERY_GRANT_TTL_MINUTES` (default 60, max 24 h);
- issuing revokes any earlier open grant (partial unique index: one open grant per customer);
- audited (`customer.recovery_grant.issued` — never the credential or hash) and visible to the
  customer as a security event; `DELETE …/recovery-grants` revokes an open grant.

### Customer side

`/recover` → Customer ID (or email) + the `AR-…` credential in the recovery-code field → reset
token → new password. On reset, in one transaction: the grant is consumed (`used_at`, conditional
update — single use even under races), the password set, the recovery code replaced; then every
session and recent-auth token is revoked and the new recovery code is shown once. Wrong or expired
credentials count towards the normal recovery lockouts and return the same generic error.

The admin customer page then shows _"Last grant used"_; the credential itself is never shown again.
