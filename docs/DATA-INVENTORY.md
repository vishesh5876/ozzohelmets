# Data inventory

What personal data the platform holds, where it lives, how it is protected, how long it is kept
and how it is backed up. Related: [DATA-RETENTION](DATA-RETENTION.md) ·
[PRIVACY-REQUESTS](PRIVACY-REQUESTS.md) · [SECURITY](SECURITY.md) ·
[DISASTER-RECOVERY](DISASTER-RECOVERY.md).

There is **no** dealer, distributor, partner, inventory, OTP or SMS data, and no payment data.

## Storage locations (single VPS)

| Location                                           | Contents                                                                                                       | Protection                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| PostgreSQL `/srv/helmet-platform/postgres`         | all records below                                                                                              | private Docker network, no published port; medical fields AES-256-GCM encrypted at the application level |
| Uploads `/srv/helmet-platform/uploads`             | profile photos (re-encoded, metadata stripped), warranty proofs (PDF/images)                                   | UID 1000, dirs 0700, files 0600, served only through the API with per-request authorisation              |
| Redis (memory + AOF in `/srv/…/redis`)             | rate-limit counters, caches of public pages (30 s), detection windows, reset tickets, recent-auth grants       | private network; short TTLs; no backups                                                                  |
| Backups `/srv/helmet-platform/backups` (+ offsite) | DB dump + uploads archive                                                                                      | 0600/0700; offsite copy must be encrypted at rest                                                        |
| Secrets `/etc/helmet-platform`                     | env files, encryption keyrings, TLS key                                                                        | root:helmetdeploy 0640/0700; separate offline copy                                                       |
| Logs (Docker json-file, 5 × 20 MB per container)   | request metadata                                                                                               | redacted: no IPs (edge), masked QR tokens, no bodies, no secrets or medical data                         |
| Browser                                            | portal/admin access token in memory; refresh token in an HttpOnly, Secure, SameSite=Strict, path-scoped cookie | no tokens in localStorage                                                                                |

## Records

| Data (table)                                                                                        | Personal data                                                                                        | Protection                                                                                                      | Retention                                                                                       |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Customer accounts (`users`)                                                                         | name, email, optional mobile, Customer ID, status, last login                                        | password and recovery code: Argon2id + pepper                                                                   | account deletion marks it `DELETED` and disables public sharing; **no erasure yet** (see below) |
| Emergency profile (`emergency_profiles`)                                                            | name, blood group, gender, organ donor, **date of birth, allergies, conditions, medications, notes** | DOB and medical text **encrypted** (`DATA_ENCRYPTION_KEYS`); shown publicly only per owner's visibility choices | until the owner clears it (account deletion does not erase it yet)                              |
| Profile photo (uploads + `photo_key`)                                                               | face image                                                                                           | re-encoded, EXIF stripped; served only when the owner shows it                                                  | until replaced or removed by the owner                                                          |
| Emergency contacts (`emergency_contacts`)                                                           | third parties' names, relationship, phone numbers                                                    | shown only when the owner enables contacts                                                                      | until the owner removes them                                                                    |
| Visibility settings (`emergency_visibility`, `helmet_emergency_settings`)                           | owner choices                                                                                        | —                                                                                                               | with the account                                                                                |
| Ownership, transfers, replacements (`helmet_ownerships`, `helmet_transfers`, `helmet_replacements`) | who owned which helmet when                                                                          | transfer codes hashed                                                                                           | kept (product safety and warranty history)                                                      |
| Warranty (`helmet_warranties`, `warranty_history`, uploads)                                         | purchase date, seller name/city, invoice number, proof document                                      | proofs downloadable only by the owner and authorised admins                                                     | kept (warranty obligations)                                                                     |
| Product reports (`product_reports`, events)                                                         | optional reporter email, free text, IP **hash**                                                      | admin-only                                                                                                      | kept                                                                                            |
| Scans (`helmet_scans`)                                                                              | time, IP **HMAC**, user-agent summary ("Browser on OS"), country code, device category               | no raw IPs; legacy raw UAs minimised                                                                            | **180 days** (`SCAN_DETAIL_RETENTION_DAYS`); daily aggregates kept                              |
| Security events (`customer_security_events`)                                                        | login/session events, IP HMAC, UA summary                                                            | visible to the customer and to support                                                                          | **365 days**                                                                                    |
| Sessions (`customer_refresh_tokens`, `admin_refresh_tokens`)                                        | device label, timestamps                                                                             | tokens stored hashed                                                                                            | until expiry or revocation                                                                      |
| Recovery grants, deletion requests                                                                  | support actions about a customer                                                                     | grant credentials hashed                                                                                        | kept for accountability                                                                         |
| Audit log (`audit_logs`)                                                                            | actor, action, entity, redacted metadata, IP HMAC                                                    | append-only; metadata never includes secrets or medical values                                                  | kept                                                                                            |
| Admin users (`admin_users`)                                                                         | staff name, email, role                                                                              | Argon2id passwords                                                                                              | while employed; disable rather than delete                                                      |
| Manufacturing (`helmets`, `helmet_batches`, `helmet_activation_secrets`)                            | no personal data; one-time PINs                                                                      | PINs hashed; plaintext only in the short-lived escrow (encrypted, purged when printed)                          | kept (escrow purged)                                                                            |
| Analytics (`helmet_scan_daily`, `platform_daily_stats`, risk tables)                                | counts, no personal data                                                                             | —                                                                                                               | kept                                                                                            |
| Ops (`worker_job_runs`, `worker_heartbeats`)                                                        | none                                                                                                 | —                                                                                                               | 30 days / 7 days                                                                                |

**Erasure is not implemented yet.** Completing a deletion request today revokes sessions, turns
off public sharing and marks the account `DELETED`, but keeps the profile, contacts and photo
rows ([PRIVACY-REQUESTS → open decisions](PRIVACY-REQUESTS.md#open-decisions-before-real-erasure)).
Decide retention and anonymisation with the privacy owner **before launch**, and make the privacy
notice match what actually happens.

**IP addresses:** never stored raw. They are HMAC-SHA256 hashed with `IP_HASH_SECRET` for rate
limiting, abuse detection and analytics. The edge access log does not record them.

## Who can see what

- **Public (QR scan):** only the fields the owner made visible on that helmet's emergency page.
  `/verify` shows product authenticity, never personal data.
- **Customer:** their own data, export (Phase 5), deletion request.
- **Support / admin:** per [RBAC-MATRIX](RBAC-MATRIX.md). The support summary never shows medical
  details. Every customer view is audited (`admin.customer.viewed`).
- **Operators with server access:** can read the database and uploads. Medical fields stay
  encrypted unless the keyring is also used. Limit SSH access to named people.

## Backups and personal data

Backups contain everything in PostgreSQL and uploads, including encrypted medical fields, which
stay encrypted in the dump. Accounts deleted later remain in older backups until those age out: 7 daily, 4 weekly and 3 monthly locally, plus the offsite retention. State that in the
privacy notice. After a restore, re-apply deletions completed after the backup date: look in the
audit log or in the restored-over database's `account_deletion_requests` for rows with
`completed_at` after the backup timestamp, and complete them again.
