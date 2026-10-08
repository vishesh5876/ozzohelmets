# Analytics

Operational analytics for the admin console (Phase 6). Built only from scan metadata, helmet
lifecycle, ownership, warranty and product-report records. **No medical data** (conditions,
allergies, medications, blood group, contacts) is read by any analytics or risk code, and no
visitor identity (IP, IP hash, user agent) ever leaves the API.

## Data flow

```
public QR request ──► helmet_scans (raw, 180 days)                 Redis counters
                         │                                          (misses / day)
                         ▼  worker: analytics.aggregate (10 min)         │
              helmet_scan_daily  ◄──────────────┐                        │
              platform_daily_stats ◄────────────┴────────────────────────┘
                         │
                         ▼
              Admin API /admin/analytics/*  (past days: aggregates · today: raw, indexed)
```

### What a scan row holds

| Column            | Content                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `scan_type`       | `EMERGENCY_PAGE` · `VERIFY` · `ACTIVATION`                                  |
| `scanned_at`      | timestamp                                                                   |
| `ip_hash`         | keyed HMAC-SHA-256 of the client IP (`IP_HASH_SECRET`); never the raw IP    |
| `user_agent`      | coarse "Browser on OS" summary (Phase 6+); never the raw string             |
| `device_category` | `MOBILE · TABLET · DESKTOP · BOT · OTHER` (regex on the UA, no fingerprint) |
| `cache_hit`       | served from the public cache                                                |
| `synthetic`       | test/perf data; excluded from every aggregate and risk rule                 |

Unknown or malformed tokens are **never stored** — there is no helmet to reference and we don't
keep attacker-supplied strings. They are counted in Redis (`analytics:invalid-tokens:<day>`, kept
8 days) and snapshotted into `platform_daily_stats.invalid_token_requests`.

Repeated scans by the same device and type within `SCAN_DEDUP_SECONDS` are recorded once.
Recording can be switched off with `SCAN_RECORDING_ENABLED=false` (pages keep working).

## Aggregates

| Table                  | Grain             | Notes                                                                                                                                                                            |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helmet_scan_daily`    | helmet × UTC date | total (non-bot), emergency, verify, activation, bot, distinct IP hashes, distinct device categories, last scan                                                                   |
| `platform_daily_stats` | UTC date          | generated, activated, new customers, active profiles (snapshot), scans, unique helmets, warranties, lost/stolen/damaged, reports, recovery grants, invalid tokens, alerts opened |

Every write is `INSERT … SELECT … ON CONFLICT DO UPDATE` recomputed from source tables, so a
re-run (or two racing workers) converges to the same rows. Only rows the `SELECT` produces are
touched: re-aggregating a day whose raw scans were already purged never zeroes it. The job
recomputes today and yesterday (late writes); on first run with no aggregates it backfills up to
30 days. `active_emergency_profiles` is a snapshot only "today" updates.

Bots are counted separately (`bot_scans`) and excluded from `total_scans`, public scan figures and
risk rules. Distinct-visitor figures are per day; the 7-day helmet figure sums daily distincts and
is labelled "approximate".

## Admin API (`analytics:view`)

| Endpoint                                                             | Returns                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /admin/analytics/overview?range=today\|7d\|30d\|custom&from&to` | current rates (activation, emergency sharing, warranty, proof upload), incomplete profiles, owned helmets without contacts, open reports/alerts, avg. days printed→activated; period totals; daily series; warranty by model; recent activations |
| `GET /admin/analytics/scans?range…`                                  | today / 7 d / 30 d / period counts, unique helmets, helmets with unusual activity, invalid-token requests, top 10 helmets, daily series                                                                                                          |
| `GET /admin/analytics/helmets?minLevel&includeResolved&cursor&limit` | helmets with review signals, ordered by score (cursor pagination)                                                                                                                                                                                |
| `GET /admin/analytics/helmets/:helmetCode`                           | 30-day series, totals, risk + reasons, signals, alerts (only with `risk-alert:view`), product reports, correlation note                                                                                                                          |
| `GET /admin/analytics/helmets/:helmetCode/scans?cursor&limit`        | scan events: type, time, device category, cache flag — no IP data                                                                                                                                                                                |

Ranges are UTC days; custom ranges are ordered, clamped to today and limited to 366 days.

## Admin UI

Sidebar **Analytics** → tabs **Overview · QR scans · Helmet activity · Risk alerts**, plus a
helmet analytics page (`/analytics/helmets/:helmetCode`) with the scan chart, explainable signals,
alerts, product reports, QR integrity panel and paginated scan events. Charts are a small
dependency-free SVG component (`apps/admin/src/components/DailyChart.tsx`): two validated colour
slots, legend, hover/focus tooltip and a table view so no value is hover-only.

## Customer view

`GET /customer/helmets/:id/scan-summary` (owner only, 404 otherwise) — counts since
`max(this ownership's start, now − 30 days)`, excluding bots:

> Your helmet QR was accessed 3 times in the last 30 days.

No IP, location, device or risk detail; customers are never notified automatically.

## Performance

`apps/api/scripts/perf-analytics.ts` seeds a dedicated `*_perf` database (refuses any other) and
times the jobs and read paths, counting every SQL statement. Results for 1,000 helmets / 100,000
scans (10 deliberately hot helmets) on the development container:

| Step                                      | ms  | queries |
| ----------------------------------------- | --- | ------- |
| aggregate: 30-day backfill (31 days)      | 724 | 64      |
| aggregate: steady state (today+yesterday) | 43  | 5       |
| risk.evaluate (first run, 10 flagged)     | 361 | 284     |
| risk.evaluate (repeat, dedup)             | 254 | 224     |
| retention.cleanup                         | 5   | 3       |
| GET overview 30d                          | 14  | 7       |
| GET scans 30d                             | 20  | 11      |
| GET helmet activity (25)                  | 8   | 6       |
| GET helmet detail                         | 15  | 13      |
| GET helmet scans (50)                     | 8   | 4       |
| GET risk alerts (25)                      | 5   | 2       |

Read queries are constant-count (no N+1). Risk evaluation is one grouped query for candidates plus
≈ 20 small statements per _flagged_ helmet (signal upserts, assessment, alert); normal helmets
cost nothing beyond the grouped query. See DATA-RETENTION.md for the partitioning threshold.
