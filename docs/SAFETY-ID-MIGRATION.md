# Safety ID migration (Phase 8 → 9) and deployment plan

**High-risk release.** It moves the identity of every printed QR from `helmets` to `safety_ids`.
The non-negotiables, each with an automated check:

| Must hold                                            | How it is guaranteed / checked                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Existing QR codes and URLs keep working              | Public token copied verbatim (decision 62); `verify-phase9-migration.sql`; `public-baseline.py` replay; integration fixture test    |
| Unused printed PINs keep working                     | PIN hash, used flag, attempts, lock and escrow copied (decision 63); verify script; fixture test activates with a pre-migration PIN |
| Consumed PINs stay consumed                          | same                                                                                                                                |
| Nobody's emergency information appears or disappears | sharing switches and ACTIVE state copied 1:1 (verify script checks both)                                                            |
| Owners unchanged                                     | ownership + history copied (verify script)                                                                                          |
| Rollback possible                                    | expand-only: nothing dropped or renamed; dual-write keeps the helmet columns current for linked Safety IDs                          |

## 1. What the migrations do

| Migration                                       | Content                                                                                                                                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261011090000_phase9_safety_id`               | Part 1: additive DDL (new tables, enums, nullable FKs; only relaxes NOT NULL on `helmets.public_token`, `helmets.activation_pin_hash`, `helmet_scans.helmet_id`). Part 2: constraints and indexes. Part 3: **backfill** (below), idempotent. |
| `20261011100000_phase9_security_events`         | new `CustomerSecurityEventType` values (`SAFETY_ID_ACTIVATED`, `SAFETY_ID_TRANSFERRED_OUT`, `SAFETY_ID_RECEIVED`)                                                                                                                            |
| `20261011110000_phase9_helmet_batch_safety_ids` | `helmet_batches.with_safety_ids` (default false for existing batches; pending, never-generated batches are switched to true), FK + index on `safety_id_batches.helmet_batch_id`                                                              |
| `20261012090000_phase9_risk_alert_subject`      | widens the `risk_alerts_subject` check so an alert about a standalone Safety ID is valid (found by the 100k-scan performance run)                                                                                                            |

Backfill (Part 3), per helmet that has a QR (`public_token` and `activation_pin_hash` set):

1. `safety_ids` row with **the helmet's UUID as id** (decision 60), code `SI-` + Helmet ID body,
   same token, PIN hash, used flag, attempts, lock, QR integrity, `activated_at`. Status:
   GENERATED / PRINTED for never-activated helmets (by helmet status), ACTIVE when the current
   owner's sharing switch is on, otherwise ACTIVATED. Physical lifecycle (lost, stolen, damaged,
   recalled, replaced, retired) stays on the helmet and is applied by the public page as before.
2. Escrow rows copied (`safety_id_activation_secrets`, ciphertext unchanged: AAD = same UUID).
3. Current link `safety_id_helmet_links` (reason `MIGRATION`).
4. Ownership history copied (source `MIGRATION`), current owner identical.
5. Sharing switches copied to `safety_id_emergency_settings`.
6. `helmet_scans.safety_id`, daily aggregates, risk assessments, signals, alert `safety_id` and
   dedup keys (`helmet:<id>:…` → `safety:<id>:…`), product reports' `safety_id`.

Everything uses `INSERT … ON CONFLICT DO NOTHING` / guarded `UPDATE`s, so it is safe to re-run.

## 2. Scripts

| Script                                         | Purpose                                                                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/scripts/verify-phase9-migration.sql` | read-only; 16 checks (above) + counts. Every row must say `OK`.                                                                                                                                 |
| `apps/api/scripts/reconcile-phase9.sql`        | idempotent re-application of the backfill for rows the **old** app wrote during the deploy window or after a rollback; touches only still-linked migrated pairs; no-op on a consistent database |
| `apps/api/scripts/public-baseline.py`          | captures public emergency + verify responses for every token before and after, compares per token (only expected difference: message wording)                                                   |

Results in development: the backfill fixture test (integration suite) and a copy of the
development database: verify 16/16 OK; reconcile no-op; replay of 257 tokens: 0 differences in
state, profile, contacts, warnings or verify data, 257 expected wording changes.

## 3. Deployment plan

Production currently runs the Phase 7 code with PM2 (Phase 8 was never deployed), so this
release applies the Phase 8 and Phase 9 migrations together. Schedule a low-traffic window and
have two people present. Never run `prisma migrate reset` or `prisma db push`; never delete a
volume, a backup set or a database.

### 3.1 Rehearsal (required, before the window)

1. Take a backup on the server and copy it offsite (`scripts/pg-backup.sh`; check
   `SHA256SUMS`).
2. Restore it into a scratch database on a **non-public** machine or the scratch database on
   the server (PM2-DEPLOYMENT → Restore). Never into `ozzo`.
3. Start the **currently deployed** build against the copy with scan recording off and the
   public abuse limits relaxed; capture: `public-baseline.py capture … before.json`.
4. Run `prisma migrate deploy` with this release; time it.
5. `psql -X -f apps/api/scripts/verify-phase9-migration.sql`: all `OK`.
6. Start this release against the copy; capture `after.json`; `public-baseline.py compare`:
   `RESULT: OK`.
7. Activate one unused PIN from the copy in a browser (pick a never-activated QR) and check the
   emergency page of one active profile. Drop the scratch database and delete the captures.

Go / no-go: any `FAIL`, any unexpected replay difference or a failed PIN activation → stop.

### 3.2 Window

1. **Backup first:** `sudo -u ozzo /opt/ozzohelmets/scripts/pg-backup.sh`; confirm the set and
   checksum; copy it offsite; confirm the offline copy of `/etc/helmet-platform/app.env` (keys
   `PIN_HASH_PEPPER`, `PIN_ESCROW_KEYS`, `DATA_ENCRYPTION_KEYS` must not change in this release).
2. Note the current commit (`git rev-parse HEAD`) for rollback.
3. Deploy: `sudo -iu ozzo /opt/ozzohelmets/scripts/pm2-deploy.sh` (backup → build →
   `prisma migrate deploy` → SPA swap → reload → readiness wait). The public page keeps being
   served by the old process until the reload; the migration is additive, so the old code keeps
   working against the expanded schema in between.
4. Immediately: `psql -X -f apps/api/scripts/verify-phase9-migration.sql` (all `OK`), then
   `psql -v ON_ERROR_STOP=1 -1 -f apps/api/scripts/reconcile-phase9.sql` (covers anything the old
   process wrote between migrate and reload), then verify again.
5. Smoke: `scripts/production-smoke.sh` with the test Safety ID (`TEST_TOKEN`), then by hand:
   the emergency page of the internal test QR, its verify page, admin → Safety IDs search for
   its `SI-` code, the customer portal "My Safety IDs".
6. Watch for 30 minutes: `pm2 logs ozzo-api`, `/api/v1/health/ready`, public 5xx and 404 rates,
   activation errors.

### 3.3 Rollback

- **Code only** (the normal case): check out the noted commit and run
  `scripts/pm2-deploy.sh --no-pull`. The database stays migrated. Linked Safety IDs keep the
  helmet columns current (dual-write), so helmet QRs, PINs, sharing and lifecycle behave as
  before. What a rollback loses until the next roll-forward: **standalone Safety IDs** created
  after the deploy (their QRs do not resolve in the old code) and Safety ID transfers in
  progress. Before rolling forward again, run `reconcile-phase9.sql` and the verify script.
- **Database restore** only if the migration itself failed or the verify script fails and
  cannot be explained: stop `ozzo-api`/`ozzo-worker`, take a fresh backup of the current state,
  restore the pre-deploy set (explicit confirmation from the owner first), redeploy the previous
  commit. Anything written after the backup is lost, so prefer the code rollback.

### 3.4 Afterwards

- Keep the old helmet QR/PIN columns and `helmet_*` emergency/analytics tables for at least one
  release. Their removal is a separate, reviewed cleanup migration after a backup.
- Update the printer's template only for new batches: the helmet manufacturing CSV keeps the
  Phase 8 columns in the same order (`safetyCode` appended).
