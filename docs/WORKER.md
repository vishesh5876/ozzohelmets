# Worker

Scheduled background jobs run in a **separate process** built from the API codebase:

```
node dist/worker.js                 # scheduler (production)
node dist/worker.js --once <job>    # run one job and exit (ops, CI smoke tests, backfills)
node dist/worker.js --once all      # every job once; exit code 1 if any failed
pnpm --filter @helmet/api worker    # same as the first line
```

It is a Nest application context (`WorkerModule`): configuration, logging, Prisma, Redis, audit,
security events, the public cache and the analytics services — **no HTTP server, no controllers**.
Same Docker image as the API, different command (see `docker-compose.yml`, service `worker`). No
message broker, no microservices: PostgreSQL is the coordination point.

## Jobs

| Job                   | Interval (default)                            | Work                                                                                     |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `analytics.aggregate` | `ANALYTICS_AGGREGATION_INTERVAL_MINUTES` (10) | helmet + platform daily aggregates for today and yesterday; 30-day backfill on first run |
| `risk.evaluate`       | `RISK_EVALUATION_INTERVAL_MINUTES` (5)        | signals → assessments → deduplicated alerts                                              |
| `retention.cleanup`   | `RETENTION_INTERVAL_MINUTES` (60)             | scan details, security events, old job runs, optional aggregate retention                |

First runs are staggered a few seconds after start.

## Safety with several workers

`JobRunnerService.run(job)` opens a transaction and takes
`pg_try_advisory_xact_lock(hashtext('helmet-job:<job>'))`. If another process holds it the run
returns `SKIPPED` immediately; the lock is released automatically when the transaction ends, even
if the process dies. Every job is idempotent (upserts recomputed from source rows, conditional
updates, partial unique indexes), so a crash mid-run is repaired by the next run. Each non-skipped
run is recorded in `worker_job_runs` (`RUNNING → SUCCEEDED | FAILED`, duration, small result
detail or error message). Jobs have a timeout (15 min; retention 60 min).

Scale horizontally by running more replicas; they share work by job, never duplicate it.

## Health and shutdown

The scheduler touches `/tmp/helmet-worker-heartbeat` every 30 s (`WORKER_HEARTBEAT_FILE`); the
compose healthcheck fails when it is older than 2 minutes. `SIGTERM`/`SIGINT` stop new runs and
wait for in-flight jobs before exiting. Run under an init process (`init: true`).

## Operations

- Migrations are applied by the API container (`prisma migrate deploy`); the worker starts after
  the API is healthy.
- Job history: `SELECT job, status, started_at, duration_ms, detail FROM worker_job_runs ORDER BY
started_at DESC LIMIT 20;`
- Backfill after an outage: `node dist/worker.js --once analytics.aggregate` (recomputes today and
  yesterday; older days can be recomputed with `AnalyticsAggregationService.aggregateDay`).
- The API process no longer runs any timers (the Phase 5 security-event purge moved here).
