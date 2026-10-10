# Launch checklist

Work through every item on the **real production VPS and domains**. Record who checked each one
and when. Items marked **(blocker)** must be done before the first QR label reaches a customer.

Related: [VPS-DEPLOYMENT](VPS-DEPLOYMENT.md) · [DISASTER-RECOVERY](DISASTER-RECOVERY.md) ·
[MONITORING](MONITORING.md) · [INCIDENT-RESPONSE](INCIDENT-RESPONSE.md) ·
[runbooks/manufacturing](runbooks/manufacturing.md).

## Infrastructure

- [ ] VPS sized per VPS-DEPLOYMENT §1 (≥ 2 vCPU / 4 GB recommended), Ubuntu 24.04 LTS, automatic
      security updates on, swap configured.
- [ ] SSH: key-only, root login off, `helmetdeploy` user, fail2ban or provider firewall. At least
      two named people have access.
- [ ] UFW: only 22, 80 and 443 open (`sudo ufw status verbose`). From outside,
      `nmap -Pn <vps-ip>` shows nothing else, in particular not 5432, 6379, 4000, 9090 or 9093.
- [ ] Docker log rotation (`/etc/docker/daemon.json`) and the compose json-file limits are active.
- [ ] Time sync (`timedatectl`: NTP active).

## Cloudflare, DNS and TLS

- [ ] `safe.`, `admin.` and (optionally) `api.` records are **proxied** (orange cloud).
- [ ] SSL mode **Full (strict)**. Origin certificate installed in `/etc/helmet-platform/tls`.
- [ ] "Always use HTTPS" on. HSTS is set at the origin edge; enable it in Cloudflare only once you
      are sure.
- [ ] Decide on the origin lock (`ORIGIN_ACCESS=cloudflare-only`) versus a fallback for
      Cloudflare outages (DISASTER-RECOVERY §8). Record the decision.
- [ ] If the origin lock is on: `scripts/update-cloudflare-ips.sh` is scheduled (weekly cron).
- [ ] WAF managed rules on. **No** challenge or CAPTCHA rule on `/e/*` or `/api/v1/public/*`.
- [ ] Unknown hostname on the origin IP is refused: `curl -k https://<vps-ip>/` gives an empty
      reply.

## Configuration and secrets

- [ ] `/etc/helmet-platform/*.env` modes are 0640 (root:helmetdeploy). No `.env` exists in the
      checkout. `git status` is clean on the deployed tag.
- [ ] Every secret was generated separately. The API starts, which proves the production guards
      pass: no dev or reused secrets, a strong DB password, https-only CORS, HTTPS QR URL, Swagger
      off.
- [ ] `PUBLIC_EMERGENCY_BASE_URL` is the **final** domain **(blocker)**: it is printed into every
      QR code.
- [ ] **Offline copy of `/etc/helmet-platform` (both keyrings and both peppers)** held by two
      named people, tested by a restore drill **(blocker)**.
- [ ] `TRUST_PROXY` matches `EDGE_SUBNET`. `TRUST_CLOUDFLARE=false` (the edge handles Cloudflare).
- [ ] `MALWARE_SCAN_ENABLED`: decision recorded. ClamAV is recommended for public launch. It needs
      about 1.2 GB RAM.
- [ ] First SUPER_ADMIN created with `admin:bootstrap`. Further admins created in the console,
      with the least role needed. No shared admin accounts.

## Backups and recovery

- [ ] `helmet-backup.timer` enabled. One manual `scripts/backup.sh` succeeded.
- [ ] **OFFSITE BACKUP CONFIGURED** (`BACKUP_OFFSITE_CMD`), on a different provider, encrypted, with
      credentials that cannot delete history **(blocker)**.
- [ ] **Restore drill from the offsite copy** (`scripts/restore-drill.sh`) passed on this VPS.
      Duration recorded **(blocker)**.
- [ ] A rebuild on a scratch VPS from the offsite backup plus the offline secrets has been
      rehearsed once (DISASTER-RECOVERY §1).

## Monitoring

- [ ] **External uptime checks** (MONITORING §1) for the test helmet's emergency page,
      readiness, admin and TLS expiry, alerting a phone **(blocker)**.
- [ ] Prometheus `monitoring` profile running with a **real Alertmanager receiver**, or a recorded
      decision to rely on external checks plus the built-in status.
- [ ] Admin → System status shows the worker alive and all jobs with a recent last success.
- [ ] Incident contacts filled in (INCIDENT-RESPONSE → Contacts).

## Application smoke test (production, after deploy)

- [ ] `deploy-vps.sh` smoke checks are all green. The footer shows the expected version and commit.
- [ ] `/api/v1/health/ready` returns `ok`. `/api/v1/internal/metrics` returns 404 from the
      internet.
- [ ] Customer flow with an internal test helmet: activate with the PIN → account → emergency
      profile → sharing on → `/e/<token>` shows exactly the approved fields.
- [ ] Profile photo and warranty proof upload. The proof downloads for the owner. Another account
      gets 404, anonymous gets 401.
- [ ] Admin: login, analytics, audit log entries for the actions above.
- [ ] Browser devtools on `/e/<token>`, the portal and admin: no CSP violations, no mixed content.
      Response headers include HSTS, CSP, `X-Content-Type-Options` and `Referrer-Policy`.
- [ ] Container restart persistence: `scripts/compose.sh restart`, then the photo and proof are
      still served.

## Physical QR test (blocker)

The QR label is the product. Test the **real printed label from the production print run**, not a
screen image.

- [ ] Print test labels from the production export (manufacturing runbook steps 1–6) on the
      **actual label material and size**.
- [ ] Scan with the **native camera app** on at least: one recent iPhone, one older iPhone, one
      recent Android, one budget or older Android (Google Lens / camera).
- [ ] Each scan opens `https://<final domain>/e/<token>` over **mobile data**, not Wi-Fi, and
      shows the correct state: "not yet activated" before activation, and the approved profile
      after activation and sharing.
- [ ] Scan distance and angle: from 20–40 cm, at about 45°, in low light and bright sunlight, and
      with the label slightly curved (as on a helmet shell).
- [ ] Scan the label **after** applying it to a helmet, and after a wipe with a damp cloth.
- [ ] The emergency page is readable on a small screen, with no login, no app install and no
      cookie banner in the way. "Call emergency" (`EMERGENCY_NUMBER`) dials correctly.
- [ ] `/verify/<token>` from the same label shows the correct model and Helmet ID, matching the
      ID printed inside the helmet.
- [ ] The Helmet ID barcode inside the helmet scans with a handheld scanner (if support uses one).

## Process and people

- [ ] Manufacturing runbook rehearsed with the printer: encrypted CSV transfer, mark printed, CSV
      destroyed.
- [ ] Support team trained on the support view, recovery grants, compromised QR runbook and
      replacement flow.
- [ ] Privacy notice published. It matches DATA-INVENTORY: public fields, retention, backups, and
      **what account deletion currently does** (no erasure yet). Data-retention and erasure
      decisions made with the privacy owner.
- [ ] Incident process walked through once (tabletop: "emergency pages down at 2 am").

## Accepted conditions (record explicitly if launching without them)

| Condition                       | Risk if missing                                                                                           | Owner | Date |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- | ----- | ---- |
| Offsite backup + tested restore | VPS loss = total, unrecoverable data loss                                                                 |       |      |
| External uptime monitoring      | outages go unnoticed until customers report them                                                          |       |      |
| ClamAV for warranty uploads     | malicious PDFs stored (they are structure-checked and only served as downloads to their owner and admins) |       |      |
| Single VPS (no HA)              | hardware/provider failure = downtime until restore                                                        |       |      |
