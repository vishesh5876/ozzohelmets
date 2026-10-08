# Data retention

Retention applies to **high-volume operational data only**. It never deletes ownership,
manufacturing, warranty, audit, product-report, alert or risk-assessment history.

| Data                                                                                                               | Kept                                                             | Setting                                         | Removed by                                     |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `helmet_scans` (detail)                                                                                            | 180 days (minimum 2 — needed for aggregation)                    | `SCAN_DETAIL_RETENTION_DAYS`                    | worker `retention.cleanup`                     |
| `helmet_scan_daily`                                                                                                | forever (default)                                                | `ANALYTICS_AGGREGATE_RETENTION_DAYS` (0 = keep) | worker                                         |
| `platform_daily_stats`                                                                                             | forever                                                          | —                                               | —                                              |
| customer security events                                                                                           | 365 days                                                         | `SECURITY_EVENT_RETENTION_DAYS`                 | worker (moved from the API process in Phase 6) |
| `worker_job_runs`                                                                                                  | 30 days                                                          | `WORKER_JOB_RUN_RETENTION_DAYS`                 | worker                                         |
| Redis detection counters                                                                                           | their window (minutes–hours); daily invalid-token counter 8 days | —                                               | Redis TTL                                      |
| audit log, ownership, transfers, warranty, manufacturing, status history, product reports, risk alerts/assessments | never deleted by retention                                       | —                                               | —                                              |

**Legacy scan minimisation.** Scans recorded before Phase 6 kept the raw User-Agent (≤ 255
chars). Each `retention.cleanup` run replaces up to 10,000 of them with the "Browser on OS" summary
and device category that new rows get (idempotent, batched by 1,000). Verified on an upgraded
database: 150 legacy rows → 0 raw user agents after one run.

Scan deletes run in batches of 10,000 (`DELETE … WHERE id IN (SELECT … LIMIT 10000)`) so a large
backlog never holds long locks. Aggregates for a purged day are never zeroed: aggregation only
upserts rows its `SELECT` produces. The integration test "retention & jobs" runs with a fixed
clock and checks that old scans go, aggregates, audit and ownership stay, and re-aggregating a
purged day keeps its numbers.

Customer account deletion (Phase 5) is separate and keeps the same safety records.

## Partitioning — evaluated, not implemented

`helmet_scans` is append-only and time-ordered, a classic partitioning candidate. It is **not
partitioned yet** because:

- At the synthetic scale (100k scans, 1,000 helmets) every read is ≤ 20 ms and retention deletes
  are milliseconds, using the existing `(helmet_id, scanned_at)` and `(scanned_at)` indexes.
- Dashboards read aggregates; raw scans are only read for "today", one helmet's 24 h/30 days, and
  the risk job's 24 h window — all index range scans.
- Prisma does not manage declarative partitions; adopting them means hand-written migrations and a
  table swap, which is only worth it when it buys something.

**Revisit when** the table exceeds ~50 M rows or retention deletes take more than a few seconds
per batch. Plan: monthly range partitions on `scanned_at` (`PARTITION BY RANGE`), created ahead by
the worker; retention becomes `DROP`/`DETACH PARTITION` instead of `DELETE`; the primary key
becomes `(id, scanned_at)`. Aggregates and APIs don't change.
