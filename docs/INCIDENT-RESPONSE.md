# Incident response

Related: [DISASTER-RECOVERY](DISASTER-RECOVERY.md) · [MONITORING](MONITORING.md) ·
[runbooks/](runbooks/) · [VPS-DEPLOYMENT](VPS-DEPLOYMENT.md).

**Priority order during any incident:** (1) public emergency pages `/e/<token>` → (2) data
integrity and confidentiality → (3) customer login and portal → (4) admin console, analytics
and worker jobs.

All commands run on the VPS as `helmetdeploy` from `/opt/helmet-platform`.
`scripts/compose.sh` wraps `docker compose` with the production files.

## Severity

| Severity | Definition                                                                                                                                                 | Response                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **SEV1** | Emergency pages down or wrong for many helmets · confirmed data breach or key/secret leak · data loss · VPS lost                                           | immediately, any hour; incident lead + second person; customer comms likely |
| **SEV2** | Logins/portal down while emergency pages work · Redis down · worker down > 1 h · backups failing > 24 h · disk > 90 % · suspected (unconfirmed) compromise | within 1 h during the day, next morning at night if emergency pages are OK  |
| **SEV3** | Single feature broken · analytics delayed · elevated 5xx below alert thresholds · one compromised QR label                                                 | next working day                                                            |

## First 10 minutes (every incident)

1. **Is the emergency page working?** Open a known test helmet's `/e/<token>` from a phone on
   mobile data, not from the office network. Check the external uptime monitor.
2. Open an incident note (time, who, what you see). Write down every action with its time.
3. Look, don't change yet:
   ```bash
   scripts/compose.sh ps                                    # health of every container
   curl -s https://safe.example.com/api/v1/health/ready     # ok | degraded | 503
   scripts/compose.sh logs --since 30m --tail 300 api worker edge
   df -h /srv /var/lib/docker; free -m; uptime
   cat /srv/helmet-platform/deploy-state/releases.log | tail -5   # was there a recent deploy?
   ```
4. A deploy in the last few hours plus new errors → roll back first
   (`scripts/deploy-vps.sh --rollback <previous tag>`) and investigate afterwards.
5. Choose the runbook below.

## Playbooks

### Emergency pages down — SEV1

Runbook: [runbooks/public-emergency-outage.md](runbooks/public-emergency-outage.md).

### API down / 502 from the edge

- `scripts/compose.sh ps api`: restarting or unhealthy? Look at `logs api` for the startup
  error. Configuration guard messages name the bad variable. "Upload storage is not writable"
  means a permissions or disk problem on `/srv/helmet-platform/uploads`.
- Out of memory: `dmesg -T | grep -i oom`. Raise the `api` memory limit (`deploy.resources.limits`, 768M) in `docker-compose.prod.yml`, or find the leak.
- `scripts/compose.sh up -d api`, then watch readiness.

### PostgreSQL down

- Readiness 503 and liveness 200. Cached emergency pages keep working for up to 30 s per token,
  then return a clean 503.
- `scripts/compose.sh logs postgres`: disk full? (`df -h /srv`). Corruption? See
  DISASTER-RECOVERY §2.
- `scripts/compose.sh up -d postgres`. The API reconnects by itself within seconds (verified:
  about 4 s).

### Redis down — SEV2

Emergency and verify pages are served from PostgreSQL. Logins, refresh and password changes return
503 by design (rate limits and lockouts fail closed). `scripts/compose.sh up -d redis`. If Redis
is full (`noeviction`): `scripts/compose.sh exec redis redis-cli info memory`. Raise
`REDIS_MAXMEMORY`. Do not switch to an evicting policy, because security keys would be dropped
silently.

### Worker down or jobs failing

Admin → Dashboard → System status shows the heartbeat and each job's last success. The API and
public pages are unaffected. `scripts/compose.sh logs worker`, then `scripts/compose.sh up -d worker`.
Jobs catch up on start (verified: all three in 11 s). Run one by hand:
`scripts/compose.sh run --rm --no-deps worker node dist/worker.js --once all`.

### Disk filling up

`du -xh --max-depth=2 /srv/helmet-platform /var/lib/docker | sort -h | tail`. Usual causes:
backups (lower `KEEP_*`, check that the offsite copy works before deleting anything), Docker
images (`docker image prune --filter until=720h`; keep the previous release), or container logs
(capped at 5 × 20 MB per container). Never delete anything under `postgres/` or `uploads/`.

### High error rate / slow responses

Prometheus (if enabled) or `scripts/compose.sh logs api | grep '"level":50'`. Check CPU
(`docker stats`): a login flood shows up as `helmet_password_hash_rejected_total` rising and
503 "busy" on login. Emergency pages stay fast by design. Edge 429s mean the per-IP limits
are being hit. Look at Cloudflare analytics for the source and add a WAF rule there.

### Abuse: enumeration / scraping of QR tokens

Detection is automatic: admin → Analytics → Alerts. Sources are already throttled. For a large
attack, add a Cloudflare WAF rate-limit or challenge rule on `/api/v1/public/*` for the source
ASN or country. Never challenge `/e/*` globally: an emergency responder must not see a CAPTCHA.
Prefer targeted rules.

### Compromised QR label (copied or cloned)

Runbook: [runbooks/compromised-qr.md](runbooks/compromised-qr.md). SEV3 for one label. SEV2 if
it spans a batch.

### Suspected breach or leaked secret — SEV1

1. Contain: if an admin account is suspected, suspend it in the console (or set its status in
   the DB) and revoke its sessions. If the server is suspected, take a disk snapshot at the
   provider **before** changing anything.
2. Preserve: copy `scripts/compose.sh logs --since 72h` output and `audit_logs` (admin → Audit,
   or `pg_dump -t audit_logs`) to a safe location.
3. Rotate what may have leaked (VPS-DEPLOYMENT → secret inventory):
   - JWT secrets: forces re-login.
   - Database password.
   - `METRICS_TOKEN`.
   - TLS key.
   - `DATA_ENCRYPTION_KEYS`: add a new version and run `encryption:rotate`. This only helps if
     the attacker had the key but not yet the data.
   - Never rotate `CUSTOMER_CREDENTIAL_PEPPER` or `PIN_HASH_PEPPER` without a plan. Doing so
     invalidates every password or every printed PIN.
4. Assess with the audit log: which admins viewed which customers (`admin.customer.viewed`),
   exports, role changes.
5. Personal or health data involved → notify the privacy owner/DPO the same day. Legal deadlines
   for authority and customer notification may apply (for example 72 hours under GDPR, and
   "without undue delay" under India's DPDP Act). Decide with counsel.

### Bad data change by an admin or support user

Audit log first (who, what, when). Correct through the console where possible. Otherwise follow
DISASTER-RECOVERY §6 (restore into the drill project, copy rows back, with review).

## Communication

- Status: if emergency pages are affected for more than 15 minutes, post on the status page or
  social channel. Never reveal security details while the incident is open.
- Customers: only after the facts are confirmed; for a breach, as the privacy owner and counsel
  decide.
- Afterwards: blameless review within 5 working days (timeline, impact, root cause, actions with
  owners) stored with the ops records. Update the runbooks.

## Contacts (fill in before launch)

| Role                                    | Name | Phone / channel |
| --------------------------------------- | ---- | --------------- |
| Incident lead (primary)                 |      |                 |
| Incident lead (backup)                  |      |                 |
| VPS provider support                    |      |                 |
| Cloudflare account owner                |      |                 |
| Privacy owner / DPO                     |      |                 |
| Holders of the offline keyring copy (2) |      |                 |
