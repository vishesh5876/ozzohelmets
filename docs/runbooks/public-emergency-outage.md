# Runbook: public emergency page outage (SEV1)

Trigger: the external uptime monitor reports `/e/<test token>` failing, or the `ApiDown`,
`DatabaseDown` or `PublicEmergencySlow` alert fires, or a report comes in from the field.

Goal: riders' emergency information is reachable again **as fast as possible**. Root cause comes
later.

## 1. Confirm (2 min)

From a phone on mobile data:

- `https://safe.example.com/e/<test token>`: does the page load and show the profile?
- `https://safe.example.com/api/v1/health/live` and `/health/ready`.

| What you see                                         | Likely layer            | Go to |
| ---------------------------------------------------- | ----------------------- | ----- |
| Cloudflare error page (52x with Cloudflare branding) | origin unreachable      | 2     |
| Page shell loads, then "temporarily unavailable"     | API or PostgreSQL       | 3     |
| "Not found" for a helmet that should work            | data or lifecycle state | 4     |
| Very slow                                            | CPU / flood             | 5     |

## 2. Origin unreachable

```bash
ssh helmetdeploy@<vps>                    # can't connect → provider console; VPS may be down
scripts/compose.sh ps                     # edge up? healthy?
scripts/compose.sh exec edge wget -qO- http://127.0.0.1/__edge_health   # edge process alive
curl -sk --resolve safe.example.com:443:127.0.0.1 -o /dev/null -w '%{http_code}\n' https://safe.example.com/
sudo ufw status                           # 80/443 allowed?
```

- Edge container down → `scripts/compose.sh up -d edge`, then
  `scripts/compose.sh logs edge`. A config error names the file and line.
- TLS certificate expired, or the files are missing in `/etc/helmet-platform/tls` → re-issue it
  (Cloudflare Origin CA).
- `ORIGIN_ACCESS=cloudflare-only` and Cloudflare changed its IP ranges → run
  `scripts/update-cloudflare-ips.sh`, then reload the edge.
- VPS gone → DISASTER-RECOVERY §1.

## 3. API or PostgreSQL

```bash
scripts/compose.sh ps api postgres redis
scripts/compose.sh logs --since 15m --tail 200 api postgres
```

- **Postgres down** (readiness 503): `scripts/compose.sh up -d postgres`. If it does not start:
  check the disk (`df -h /srv`), then the logs. Free space by pruning images or old backups
  **after** confirming the offsite copy. Never delete anything in `postgres/`.
- **API crash loop:** read the first error after start. If a deploy happened recently:
  `scripts/deploy-vps.sh --rollback <previous tag>`.
- **Redis down:** emergency pages are designed to keep working from PostgreSQL. If they do not,
  that is a bug: restart Redis (`scripts/compose.sh up -d redis`) and record it.

## 4. A specific helmet shows "not found" or the wrong state

Check the helmet in admin → Helmets (search by Helmet ID):

- lifecycle state (lost, stolen, replaced and deactivated helmets show their own notice);
- whether the owner turned emergency information off;
- the QR integrity status. This never hides the emergency page, but note it.

Risk signals and `COMPROMISED` status do **not** disable emergency information. If one did, that
is a bug: escalate.

## 5. Slow

```bash
docker stats --no-stream
scripts/compose.sh logs --since 10m edge | grep -c '"status":429'
```

- Login flood: the Argon2 limiter rejects excess logins with 503 so emergency reads stay fast.
  Confirm that `helmet_password_hash_rejected_total` is rising.
- Traffic flood: use Cloudflare → Security → Events, then add a targeted WAF or rate-limit rule.
  **Never** a global challenge on `/e/*`.
- Increase capacity: `API_REPLICAS=2` in compose.env, then `scripts/deploy-vps.sh --no-build`.

## 6. After recovery

- Verify with the physical test helmet: scan its QR label with a phone camera.
- Watch for 30 minutes (System status card, alerts).
- Write the incident note and review (INCIDENT-RESPONSE → Communication).
