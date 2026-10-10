# Monitoring

Related: [VPS-DEPLOYMENT](VPS-DEPLOYMENT.md) · [INCIDENT-RESPONSE](INCIDENT-RESPONSE.md) ·
[DISASTER-RECOVERY](DISASTER-RECOVERY.md).

Monitoring comes in three layers. Only the first one can tell you that the whole VPS is gone.

| Layer                        | Where                           | Required?                  | Detects                                                                     |
| ---------------------------- | ------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| 1. External uptime checks    | **off the VPS**                 | **required before launch** | VPS / network / Cloudflare / TLS / edge / API / DB down, certificate expiry |
| 2. Built-in status           | admin → System status           | built in                   | worker heartbeat, job freshness, DB/Redis up, version                       |
| 3. Prometheus + Alertmanager | same VPS (`monitoring` profile) | recommended                | latency, error rate, disk, memory, CPU, Postgres, Redis, backups, worker    |

> **EXTERNAL UPTIME MONITORING REQUIRED FOR PRODUCTION.** Anything running on the VPS stops
> alerting when the VPS stops. Configure at least the checks below in an external service, such
> as a hosted uptime checker, Uptime Kuma on a different small server, or a monitoring SaaS.

## 1. External uptime checks

| Check                     | URL                                                             | Expect                                         | Interval | Alert after |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------------------- | -------- | ----------- |
| Emergency page (API path) | `https://safe.example.com/api/v1/public/emergency/<test token>` | 200, body contains `"success":true`            | 1 min    | 2 failures  |
| Emergency page shell      | `https://safe.example.com/e/<test token>`                       | 200, contains `emergency`                      | 1 min    | 2 failures  |
| API readiness             | `https://safe.example.com/api/v1/health/ready`                  | 200; body `"status":"ok"` (warn on `degraded`) | 1 min    | 3 failures  |
| Admin console             | `https://admin.example.com/`                                    | 200                                            | 5 min    | 2 failures  |
| TLS certificate           | `safe.example.com`, `admin.example.com`                         | > 14 days left                                 | daily    | —           |

Use a **dedicated test helmet** that is activated, has a synthetic emergency profile with
emergency sharing on, and is owned by an internal account. Its scans then appear in analytics as
that helmet only. The probes come from one or a few IPs at a steady rate, well below the
per-IP public limits. Do not point probes at real customers' helmets.

Send these alerts to a phone (push or SMS from the monitoring service) for the on-call person.
The emergency page check is SEV1 ([runbook](runbooks/public-emergency-outage.md)).

## 2. Built-in status

- **Admin → Dashboard → System status** (`GET /api/v1/admin/system/status`, `dashboard:read`):
  database and Redis up, worker heartbeat (alive workers, last beat, version) and each job's last
  run, last success, duration and failures in 24 h. The footer shows the deployed version and
  commit.
- `GET /api/v1/health/live`: process alive. `GET /api/v1/health/ready`: `ok`, `degraded`
  (Redis down, emergency still served) or 503 (PostgreSQL down).
- The worker writes a DB heartbeat every 30 s (`worker_heartbeats`, pruned after 7 days) and a
  heartbeat file used by its container health check.

## 3. Prometheus + Alertmanager (optional `monitoring` profile)

```bash
sudo install -d -m 700 -o root -g helmetdeploy /etc/helmet-platform/monitoring
grep ^METRICS_TOKEN= /etc/helmet-platform/app.env | cut -d= -f2- | \
  sudo tee /etc/helmet-platform/monitoring/metrics_token >/dev/null
sudo chmod 640 /etc/helmet-platform/monitoring/metrics_token
sudo install -m 640 -o root -g helmetdeploy deploy/env/monitoring.env.example /etc/helmet-platform/monitoring.env
# create the read-only DB role named in monitoring.env:
scripts/compose.sh exec postgres psql -U helmet -d helmet_platform \
  -c "CREATE ROLE monitoring LOGIN PASSWORD '<generated>'; GRANT pg_monitor TO monitoring;"
sudo cp deploy/monitoring/alertmanager.yml /etc/helmet-platform/alertmanager.yml   # set a real receiver
echo 'ALERTMANAGER_CONFIG=/etc/helmet-platform/alertmanager.yml' | sudo tee -a /etc/helmet-platform/compose.env
scripts/compose.sh --profile monitoring up -d
ssh -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 helmetdeploy@<vps>   # then open localhost:9090
```

Resource cost: about 0.8 GB RAM in total (Prometheus capped at 512 MB, 15 days or 2 GB of data).
On a 4 GB VPS this is acceptable. On 2 GB, rely on external checks plus the built-in status.

### Metrics exposed by the API (`/api/v1/internal/metrics`, bearer `METRICS_TOKEN`)

The edge returns 404 for this path from the internet. Labels are low-cardinality: route
**templates** (`/api/v1/public/emergency/:token`), never tokens, IDs, emails or IPs.

| Metric                                                       | Meaning                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| `helmet_http_requests_total{method,route,status}`            | requests by route template and status class                 |
| `helmet_http_request_duration_seconds{method,route}`         | latency histogram                                           |
| `helmet_dependency_unavailable_total{dependency,handling}`   | Redis/Postgres outage handling (`public_fail_open`, 503, …) |
| `helmet_password_hash_rejected_total`                        | Argon2 limiter rejections (login flood)                     |
| `helmet_uploads_total{kind,result}`                          | photo / warranty proof uploads                              |
| `helmet_audit_events_total{action}`                          | business events (activations, transfers, exports, …)        |
| `helmet_worker_heartbeat_timestamp_seconds`                  | last worker heartbeat                                       |
| `helmet_worker_job_last_success_timestamp_seconds{job}` etc. | job freshness, duration, failures (24 h), expected interval |
| `helmet_risk_alerts_open{type}`                              | open abuse / risk alerts                                    |
| `helmet_database_up`, `helmet_redis_up`, `helmet_build_info` | dependency status and version                               |
| `helmet_process_*`                                           | memory, heap, CPU, uptime of the API process                |

Backups write `helmet_backup_*` to the node-exporter textfile directory.

### Alert rules (`deploy/monitoring/alerts.yml`)

| Group     | Alerts                                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| api       | ApiDown, DatabaseDown, RedisDown, HighServerErrorRate (> 5 % 5xx), PublicEmergencySlow (p95 > 1 s), DependencyOutageTraffic |
| worker    | WorkerHeartbeatMissing (> 5 min), WorkerJobStale (> 3× interval), WorkerJobFailing                                          |
| host      | DiskSpaceWarning (< 20 %), DiskSpaceCritical (< 10 %), MemoryLow, SwapHeavy, OomKill, CpuSustainedHigh                      |
| datastore | PostgresConnectionsHigh, PostgresDeadlocks, PostgresLongTransaction, RedisMemoryHigh, RedisRejectingWrites                  |
| backups   | BackupStale (> 26 h), BackupMissingMetric, OffsiteBackupStale (> 26 h)                                                      |

The rules are validated in CI with `promtool check rules`, and `alertmanager.yml` with
`amtool check-config`. The example receiver is a placeholder webhook. **Alerts go nowhere until a
real receiver is configured.**

## Logs

- Every container uses the json-file driver, capped at 5 × 20 MB (`docker logs` /
  `scripts/compose.sh logs`). No unbounded growth.
- The API logs JSON (pino) with redaction: no passwords, tokens, PINs, cookies, authorization
  headers, medical fields, contacts, phone numbers or emails in bodies. QR tokens in URLs are
  masked (`/e/:token`). Health and metrics requests are not access-logged.
- The edge access log is JSON **without client IPs**, with QR tokens masked. SPA containers have
  no access log.
- PostgreSQL logs slow statements (> `PG_SLOW_QUERY_MS`) without bind parameters, plus lock
  waits.
- For centralised logs, ship the Docker json logs with a collector (for example Vector or
  Promtail) to a log service. Keep the redaction: do not add raw request bodies.

## Error tracking (optional)

Sentry or a compatible service can be added later. If you add it: scrub request bodies, cookies
and headers by default, and never send the emergency profile payloads.

## Disk, memory, CPU at a glance (without Prometheus)

```bash
df -h /srv /var/lib/docker
docker stats --no-stream
du -sh /srv/helmet-platform/{postgres,uploads,backups}
scripts/compose.sh exec redis redis-cli info memory | grep used_memory_human
scripts/compose.sh exec postgres psql -U helmet -d helmet_platform -c "select count(*) from pg_stat_activity"
```
