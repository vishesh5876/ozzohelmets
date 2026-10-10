# Disaster recovery

Single VPS, Docker Compose, uploads on the local filesystem. Related:
[VPS-DEPLOYMENT](VPS-DEPLOYMENT.md) · [INCIDENT-RESPONSE](INCIDENT-RESPONSE.md) ·
[MONITORING](MONITORING.md) · [DATA-INVENTORY](DATA-INVENTORY.md).

> **OFFSITE BACKUP REQUIRED FOR PRODUCTION.** `scripts/backup.sh` writes to
> `/srv/helmet-platform/backups` **on the same VPS**. That protects against mistakes, bad
> migrations and file corruption. It does **not** protect against losing the VPS, its disk or the
> hosting account. Until `BACKUP_OFFSITE_CMD` copies every backup to a different provider or
> location **and a restore from that copy has been tested**, the platform is not disaster-safe.

> **Encryption keys are not in the backups.** Medical fields are AES-256-GCM encrypted with
> `DATA_ENCRYPTION_KEYS`. A database backup without the matching keyring **cannot** restore
> blood group, allergies, conditions, medications or notes. Keep `/etc/helmet-platform/app.env`
> (both keyrings) in a separate, offline, access-controlled place, such as a password manager or
> sealed vault that two named people can open. Never store it next to the backups.

## Objectives

| Objective                      | Target                                     | Basis                                                                                       |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| RPO (max data loss)            | **24 h** (daily backup, 02:15 UTC)         | Lower by running the timer more often, e.g. every 6 h. A dump takes seconds at launch size. |
| RTO, app or data problem       | **< 1 h**                                  | Restore drill on staging data: DB + uploads in 15 s, plus checks.                           |
| RTO, VPS lost (offsite copy)   | **2–4 h**                                  | New VPS (VPS-DEPLOYMENT §2–7), fetch offsite backup, restore, DNS/TLS.                      |
| RTO, VPS lost (no offsite)     | **not recoverable**                        | All customer data, ownerships and uploads are lost. Printed QR labels still point here.     |
| Public emergency page priority | restored **first**, before admin / support | Riders depend on it. Cached pages can survive a short PostgreSQL outage (Redis, 30 s).      |

These are design targets. Measure your own restore time during the launch drill.

## What is backed up

| Item                                     | In `backup.sh`? | Where it must be kept                                       |
| ---------------------------------------- | --------------- | ----------------------------------------------------------- |
| PostgreSQL (all tables, `pg_dump -Fc`)   | yes             | backup set + offsite                                        |
| Uploads (photos, warranty proofs)        | yes (tar.zst)   | backup set + offsite                                        |
| Manifest (counts, migration, PG version) | yes             | backup set                                                  |
| `/etc/helmet-platform/*.env`, keyrings   | **no**          | **separately, offline, encrypted** (password manager/vault) |
| TLS origin certificate/key               | no              | re-issue from Cloudflare / Let's Encrypt                    |
| Redis                                    | no (ephemeral)  | not needed: rate limits, caches, detection windows          |
| Code / configs (`/opt/helmet-platform`)  | no              | git (tags)                                                  |
| Docker images                            | no              | rebuild from the tag, or a registry                         |

Backup set layout: `backups/daily/<UTC timestamp>/` holds `db.dump`, `uploads.tar.zst`,
`manifest.json` and `SHA256SUMS`. Weekly and monthly sets are hard links (no extra space).
Retention is `KEEP_DAILY=7`, `KEEP_WEEKLY=4`, `KEEP_MONTHLY=3`. Each run validates the dump with
`pg_restore --list` before publishing, and it publishes atomically. Metrics for Prometheus are
written to the node-exporter textfile directory (`helmet_backup_last_success_timestamp_seconds`,
`helmet_backup_last_size_bytes`, `helmet_backup_offsite_last_success_timestamp_seconds`).

## Offsite copy (configure before launch)

Set in `/etc/helmet-platform/backup.env`. `$BACKUP_DIR` is the new backup set:

```bash
# rclone to any S3-compatible / B2 / SFTP / Google Drive remote (configured with `rclone config`)
BACKUP_OFFSITE_CMD='rclone copy "$BACKUP_DIR" offsite:helmet-backups/$(basename "$BACKUP_DIR")'
# or rsync to a separate backup server
BACKUP_OFFSITE_CMD='rsync -a "$BACKUP_DIR" backup@backup-host:/backups/helmet/'
```

Requirements:

- A **different provider or region** from the VPS. Credentials must be **write-only or
  append-only** where possible, so a compromised VPS cannot delete old backups (bucket
  versioning or object lock, or an rsync target that snapshots).
- Encrypt in transit (TLS/SSH). Encrypt at rest. With rclone, use a `crypt` remote, because the
  dump contains personal data. Medical fields are already encrypted, but names, emails and
  ownerships are not.
- Offsite retention ≥ 30 days.
- `backup.sh` exits `2` when the offsite copy fails, so systemd marks the unit failed and the
  `OffsiteBackupStale` alert fires.

## Restore procedures

All restores use `scripts/restore.sh`. It:

- verifies `SHA256SUMS` first;
- requires `--confirm <compose project name>`;
- stops api and worker;
- moves current uploads aside (never deletes them);
- runs `prisma migrate deploy` (forward-only) after a DB restore;
- starts the services and waits for readiness.

It **never** runs without explicit confirmation.

### Drill first, always

Before restoring over production, prove the backup in an isolated project:

```bash
scripts/restore-drill.sh --backup /srv/helmet-platform/backups/daily/<ts> --drill-root /srv/helmet-drill
```

It creates project `helmet-drill` with its own data directory and network, restores, boots
api and worker, compares all row counts and the file count with the manifest, checks readiness,
runs every worker job once and prints `encryption:status`. Run it **monthly** and before every
launch or major upgrade. Afterwards, stop the drill project (`docker compose -p helmet-drill … down`)
and remove the drill directory.

### Full restore (DB + uploads) on the same VPS

```bash
scripts/compose.sh ps                              # confirm project name, e.g. helmet
scripts/backup.sh                                  # snapshot the current (bad) state first, if possible
scripts/restore.sh --backup /srv/helmet-platform/backups/daily/<ts> --confirm helmet
```

### Database only / uploads only

```bash
scripts/restore.sh --backup <set> --db-only      --confirm helmet
scripts/restore.sh --backup <set> --uploads-only --confirm helmet
```

An uploads-only restore leaves the database untouched. Photos and proofs come back with the same
keys, so every reference and every authorisation check still applies (verified in the drill below).

## Scenarios

### 1. VPS destroyed / disk lost / provider account lost

1. Provision a new VPS (VPS-DEPLOYMENT §1–2) and restore `/etc/helmet-platform` from the
   offline secret store. **The keyrings must be the original ones.**
2. Clone the repo at the last deployed tag (`releases.log` is in the backup host's copy of the
   deploy state, or use the latest tag).
3. Copy the latest offsite backup set to `/srv/helmet-platform/backups/daily/`.
4. `scripts/deploy-vps.sh --skip-backup` (starts an empty stack), then
   `scripts/restore.sh --backup <set> --confirm helmet`.
5. TLS: install the origin certificate (Cloudflare Origin CA can be re-issued in minutes).
6. Cloudflare DNS: point the A records at the new IP. Proxied records switch within seconds.
7. Verify: launch checklist "smoke" section, including a **physical QR scan**.

Data written after the last offsite backup is lost (RPO). Tell affected customers if needed.

### 2. PostgreSQL corruption

Symptoms: readiness 503, Postgres crash loop, `invalid page` / checksum errors in
`scripts/compose.sh logs postgres`.

1. Stop writers: `scripts/compose.sh stop api worker`. Cached emergency pages keep working for
   up to 30 s per token. Then pages return a clean 503.
2. Preserve evidence: copy `/srv/helmet-platform/postgres` aside (stop postgres first).
3. Try a normal restart once. If it does not come back clean, restore the latest good backup
   (`--db-only`). Drill it first if time allows.
4. Data since the backup is lost. Ownership or profile changes made in that window must be
   redone by customers.

### 3. Uploaded files lost or damaged

Symptoms: profile photos / warranty proofs return 404 while their DB rows exist.
`scripts/restore.sh --backup <set> --uploads-only --confirm helmet`. The current directory is
kept as `uploads.before-restore-<ts>` for comparison. Files uploaded after the backup are gone,
and customers must re-upload them. The emergency page still works without its photo.

### 4. Redis lost

No restore needed. Redis holds only ephemeral state. Restart it
(`scripts/compose.sh up -d redis`). While it is down:

- emergency and verify pages are served from PostgreSQL;
- logins, session refresh and password changes return 503 (fail closed);
- readiness reports `degraded`.

After it returns: rate-limit and lockout counters restart from zero, emergency caches warm up
again, and pending password-reset tickets and recent-auth grants expire, so users repeat the step.

### 5. Bad deployment

- Application bug, no migration: `scripts/deploy-vps.sh --rollback <previous tag>` restarts the
  previous images.
- Migration applied: migrations are forward-only and backward compatible for one release, so
  the rollback image still works. Fix forward with a new migration.
- Migration damaged data: `deploy-vps.sh` took a backup right before migrating
  (`releases.log` records it). Drill that backup, then restore it `--db-only` and roll back the
  images. Never `prisma migrate reset`.

### 6. Database accidentally changed (bad admin action, mistaken SQL)

1. Find the time and scope in the audit log (admin → Audit, or `audit_logs`).
2. Restore the backup from before the change into the **drill** project. Do not restore over
   production.
3. Copy the affected rows back with targeted SQL, reviewed by a second person, and record what
   was done in the incident log. A full restore over production only if the damage is broad and
   losing the newer data is acceptable.

### 7. Encryption key lost

**Unrecoverable for medical data.** Without the `DATA_ENCRYPTION_KEYS` version that encrypted a
row, its medical fields cannot be decrypted by anyone. Names, contacts' presence, ownerships and
warranty data are not affected.

- Prevention: offline keyring copies held by two people. Check the copies against production
  during every restore drill: the drill proves decryption works with them.
- If it happens anyway: keep the old ciphertexts. Do not delete them in case the key turns up.
  Ask affected customers to re-enter their medical details, and decide on customer notification
  with the privacy owner.
- Lost `PIN_ESCROW_KEYS`: only affects batches not yet exported for printing. Regenerate those
  batches.

### 8. Cloudflare unavailable

Cloudflare outages are rare and usually short. Options, in order:

1. Wait, if it is partial or short.
2. If the origin lock (`origin-cloudflare-only.conf`) is **off**, switch the DNS records to
   "DNS only" (grey cloud). Visitors then reach the origin directly. Its certificate must be
   publicly trusted (Let's Encrypt), because a Cloudflare Origin CA certificate shows browser
   warnings when not proxied. Edge rate limits stay in force.
3. If the origin lock is on, it has to be switched off first (`origin-allow-all.conf`, reload
   the edge), and DNS must be managed somewhere still reachable.

Decide at launch whether you need this fallback. It requires a Let's Encrypt certificate on the
origin in addition to, or instead of, the Origin CA certificate.

## Verified results (Phase 7, staging stack on the production compose file)

| Drill                                   | Result                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup (`backup.sh`)                    | Dump validated with `pg_restore --list`, uploads archived, manifest + checksums, GFS links, metrics written.                                                                                       |
| Full restore drill (`restore-drill.sh`) | Passed in 15 s: all 9 table counts and 80 files match the manifest; readiness ok; worker jobs ran; `encryption:status` v1 in use.                                                                  |
| App checks on the restored copy         | Customer login + ownership ok; medical profile and contacts decrypted; warranty proof byte-identical, owner-only (404 other customer, 401 anonymous); photo served; admin analytics; audit intact. |
| Uploads-only restore                    | After deleting the uploads, photo and proof returned 404; after `restore.sh --uploads-only` both 200 with authorisation unchanged.                                                                 |
| Offsite copy                            | **Not tested.** No offsite target exists in the test environment. Must be configured and drilled before launch.                                                                                    |
| Restore onto a new VPS                  | **Not tested.** Covered by scenario 1; do it once on a scratch VPS before launch.                                                                                                                  |

## Schedule

| When                      | What                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------- |
| daily (timer)             | `backup.sh` + offsite copy; alert if older than 26 h or offsite failed                  |
| monthly                   | `restore-drill.sh` from the **offsite** copy; record duration and result in the ops log |
| quarterly                 | verify the offline keyring copies decrypt a drill restore; review who can access them   |
| before each major release | manual `backup.sh`; `deploy-vps.sh` also takes one before migrating                     |
