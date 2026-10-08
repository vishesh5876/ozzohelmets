# Phase 6 — Analytics + QR Abuse / Copied-Code Detection

> **Suspicious scan activity does not prove a physical helmet is counterfeit.** A QR scan only
> proves that someone requested a registered token. Every signal here is _review guidance_ for a
> human; nothing in this phase labels a helmet counterfeit, fake or fraudulent, and nothing in it
> can switch off emergency access.

Surfaces unchanged: Admin Portal · Customer Portal · public QR pages → NestJS API → PostgreSQL +
Redis, plus a **worker process** (same codebase, separate entrypoint, no HTTP). No dealer,
distributor, inventory, partner, OTP or SMS concepts. No machine learning.

## Review of the existing scan model (start of phase)

| Area           | Finding                                                                                                                                                                                                                                       | Decision                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helmet_scans` | `helmet_id, scanned_at, ip_hash (HMAC), user_agent (≤255 raw), country_code, scan_type (EMERGENCY_PAGE/VERIFY/ACTIVATION)`; indexes (helmet, time), (time). Fire-and-forget insert; same device + type deduplicated for `SCAN_DEDUP_SECONDS`. | Keep the table (no duplicate logging). New rows store a **device summary + category** instead of the raw UA, a cache flag and a `synthetic` flag. |
| Unknown tokens | Not stored (no helmet to reference); Phase 5 counts them in Redis per IP.                                                                                                                                                                     | Keep it that way — no table of attacker-supplied strings. Add daily counters and enumeration alerts.                                              |
| Abuse controls | Per-IP miss budget, global burst mode, cached helmets always served.                                                                                                                                                                          | Extend with valid-token scraping detection (distinct helmets per IP, HyperLogLog) and alerting.                                                   |
| Cleanup        | Security-event purge ran on a timer inside every API process.                                                                                                                                                                                 | Moved to the worker; API no longer schedules anything.                                                                                            |
| Client IP      | `trust proxy` from `TRUST_PROXY`; `CF-Connecting-IP` only with `TRUST_CLOUDFLARE`.                                                                                                                                                            | Keep. Add production startup checks and a runtime warning when forwarded headers arrive while no proxy is trusted.                                |
| Volume         | Dev data: hundreds of scans. Synthetic test: 100k scans perform fine with existing indexes.                                                                                                                                                   | **No partitioning yet**; documented plan and threshold (see DATA-RETENTION.md).                                                                   |

## Design

### Aggregation (PostgreSQL, idempotent upserts by the worker)

- `helmet_scan_daily` — one row per (helmet, UTC date): total / emergency / verify / activation /
  bot scans, distinct IP hashes, distinct device categories, last scan. Computed with one
  `INSERT … SELECT … GROUP BY … ON CONFLICT DO UPDATE` per day window. No arrays of hashes.
- `platform_daily_stats` — one row per date: helmets generated/activated, new customers, active
  emergency profiles (snapshot), emergency/verify scans, unique helmets scanned, warranties
  registered, lost/stolen/damaged transitions, product reports, recovery grants, invalid-token
  requests (daily Redis counter snapshotted into the row), risk alerts opened.
- Dashboards read aggregates for past days and the raw table (indexed by time) for _today_ only.

### Risk engine (deterministic, explainable — `RISK-ENGINE.md`)

Per helmet with recent scans, evaluated every `RISK_EVALUATION_INTERVAL_MINUTES`:

| Signal                         | Rule (configurable defaults)                                                | Weight                 |
| ------------------------------ | --------------------------------------------------------------------------- | ---------------------- |
| `HIGH_SCAN_VOLUME`             | > 50 public scans / 1 h or > 200 / 24 h                                     | 15 (25 if ≥ 2×)        |
| `HIGH_UNIQUE_VISITOR_COUNT`    | > 20 distinct IP hashes / 1 h                                               | 25                     |
| `RAPID_IP_CHURN`               | > 10 distinct IP hashes / 15 min with ≥ 80 % of scans from different hashes | 20                     |
| `ABNORMAL_VERIFY_ACTIVITY`     | > 30 verify scans / 24 h **and** > 5× the 7-day daily baseline              | 20                     |
| `PRODUCT_REPORT_CORRELATION`   | ≥ 1 product report in 30 days, only alongside another signal                | 10 per report (max 20) |
| `QR_SHARED_OR_COPIED_POSSIBLE` | (unique-visitor or churn) **and** (abnormal verify or product report)       | 20                     |

Score = sum (cap 100) → level `NONE (0) · LOW (1–24) · MEDIUM (25–49) · HIGH (50–74) ·
CRITICAL (75+)`. A single signal can never exceed MEDIUM; CRITICAL needs ≥ 3 distinct signals.
Every score is returned with its reasons (observed vs threshold).

Signals are rows (`helmet_risk_signals`, one active row per helmet+type, updated in place, cleared
after `RISK_SIGNAL_CLEAR_AFTER_HOURS` without re-observation). `helmet_risk_assessments` holds the
current level/score/reasons per helmet. **Neither touches `HelmetStatus`.**

### Source-level detection (real time, Redis)

- **Token enumeration**: misses per IP hash (Phase 5 counter) crossing
  `ENUMERATION_INVALID_TOKEN_LIMIT` in the window → `TOKEN_ENUMERATION` alert (once per source per
  window). The alert stores counts and an opaque `sourceRef` (truncated hash of the IP hash), never
  attempted tokens or IP hashes.
- **Valid-token scraping**: distinct valid helmets per IP hash per window (HyperLogLog) above
  `VALID_TOKEN_SCRAPE_LIMIT` → `VALID_TOKEN_SCRAPING` alert and the source is treated like a flagged
  IP (cached helmets still served, uncached lookups rationed). Above
  `VALID_TOKEN_SCRAPE_BLOCK_MULTIPLIER ×` the limit, uncached lookups are refused.
- **Global miss burst** (Phase 5) → one `SYSTEM_RATE_LIMIT_SPIKE` alert per hour.

### Alerts

`risk_alerts`: type, status (`OPEN → ACKNOWLEDGED → INVESTIGATING → RESOLVED | DISMISSED`),
priority (risk level), helmet or opaque source, dedup key, occurrences, first/last seen,
observed/threshold values, reasons, assignee, resolution reason. A partial unique index allows one
open alert per dedup key; new observations update it. After resolve/dismiss a new alert for the
same key is suppressed for `RISK_ALERT_SUPPRESS_HOURS` unless the observed value at least doubles.

### QR integrity (human decision only)

Separate `helmets.qr_integrity_status` (`NORMAL · UNDER_REVIEW · COMPROMISED`), changed only by an
admin with `qr-integrity:manage`, audited. It never changes lifecycle status or emergency access.
When COMPROMISED, the verification page adds a neutral notice asking the viewer to compare the
Helmet ID on the inner label. No "rotate QR" action: a printed label can't change remotely —
replacement secure labels are an operations process (Phase 7).

### Worker (`WORKER.md`)

`apps/api/src/worker.ts` → `node dist/worker.js`: Nest application context (no HTTP server),
same image as the API with a different command. Three job groups, each guarded by a PostgreSQL
advisory lock so any number of workers can run safely, each idempotent, each recorded in
`worker_job_runs`:

| Job                   | Default interval | Work                                                                    |
| --------------------- | ---------------- | ----------------------------------------------------------------------- |
| `analytics.aggregate` | 10 min           | helmet + platform daily aggregates for today and yesterday (+ backfill) |
| `risk.evaluate`       | 5 min            | signals → assessments → alerts                                          |
| `retention.cleanup`   | 60 min           | expired scan details, security events, job runs (batched)               |

`node dist/worker.js --once <job>` runs a single job (ops, tests, CI smoke).

### Privacy boundaries

No precise location, no raw IP (HMAC only), no fingerprinting, device stored as a coarse category
and "Browser on OS" summary, no query strings, no medical data anywhere in analytics or risk
(only scan metadata, lifecycle, product reports, verification patterns). Customers see only neutral
counts for their own helmet since their ownership began. Risk alerts are admin-only.

### RBAC

`analytics:view` (SUPER_ADMIN, ADMIN, SUPPORT, ANALYTICS_VIEWER), `risk-alert:view` and
`risk-alert:manage` (SUPER_ADMIN, ADMIN, SUPPORT), `qr-integrity:manage` (SUPER_ADMIN, ADMIN).
MANUFACTURING gets none of them.

## Delivered

| Area             | What                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema           | Migration `20261006090000_phase6_analytics_risk` (additive): aggregates, assessments, signals, alerts, job runs, QR integrity, scan device/cache/synthetic columns                                         |
| Worker           | `dist/worker.js` (+ `--once`), advisory-locked idempotent jobs, run history, heartbeat, compose service; security-event purge moved out of the API                                                         |
| Aggregation      | `helmet_scan_daily`, `platform_daily_stats`; today + yesterday + first-run backfill; never zeroes purged days                                                                                              |
| Risk engine      | 6 deterministic signals, weighted score with guards, stored reasons, auto-clear; never touches lifecycle/QR integrity                                                                                      |
| Source detection | enumeration alerts + daily invalid-token counter; valid-token scraping (HyperLogLog) with flag → ration → refuse-uncached; burst alert                                                                     |
| Alerts           | 5 types, 5 statuses, priority, assignee, resolution reason, dedup (partial unique index), suppression, audit                                                                                               |
| QR integrity     | admin-only `NORMAL / UNDER_REVIEW / COMPROMISED`, audited, cache-invalidating, neutral verify notice                                                                                                       |
| Admin UI         | Analytics nav + Overview · QR scans · Helmet activity · Risk alerts tabs; helmet analytics page; dependency-free SVG charts with table view                                                                |
| Customer         | neutral scan summary on the helmet page; verification page shows the integrity notice                                                                                                                      |
| Privacy          | UA summary + device category instead of raw UA (legacy rows minimised by the worker); no IP data in any analytics response; no medical data used                                                           |
| Trust proxy      | production rejects `TRUST_PROXY=true` and a missing proxy config; runtime warning on forwarded headers while untrusted                                                                                     |
| RBAC             | `analytics:view`, `risk-alert:view`, `risk-alert:manage`, `qr-integrity:manage`; matrix regenerated                                                                                                        |
| Docs             | ANALYTICS, RISK-ENGINE, QR-ABUSE-DETECTION, DATA-RETENTION, WORKER (new); README, ARCHITECTURE, DATABASE, SECURITY, API, PHASES, SECURITY-HARDENING, RBAC-MATRIX, PRODUCT-AUTHENTICITY, DEPLOYMENT updated |

## Verification

| Gate                                | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format:check`, `lint`, `typecheck` | clean                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Unit tests (`pnpm test`)            | 242 passed (36 suites) — risk rules & guards, false-positive scenarios, device category, cursor, ranges, alert transitions/dedup/suppression, abuse controls, env/trust-proxy, RBAC matrix                                                                                                                                                                                                                                                                     |
| Integration (`pnpm test:e2e`)       | 178 passed (17 suites), incl. `phase6-analytics` (17): aggregation idempotency, risk scenarios, public availability under HIGH risk + COMPROMISED, enumeration/scraping over HTTP, alert workflow + audit, cursor pagination, RBAC, no IP data, customer summary isolation, retention with fixed clock, legacy minimisation, advisory lock                                                                                                                     |
| Playwright                          | 49 passed — all earlier journeys + Phase 6 journey (scans → worker `--once all` → admin analytics/alert/QR integrity → owner summary → public pages)                                                                                                                                                                                                                                                                                                           |
| `pnpm build`                        | api (+ worker), admin, portal                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Migrations                          | fresh deploy ✓; upgrade Phase 4 data → Phase 5 → Phase 6 with legacy scans ✓ (row counts unchanged, worker runs on it); `migrate diff` no drift ✓                                                                                                                                                                                                                                                                                                              |
| Performance                         | 1,000 helmets / 100,000 scans: reads ≤ 20 ms, constant query counts; backfill 0.7 s; see ANALYTICS.md                                                                                                                                                                                                                                                                                                                                                          |
| Docker / smoke                      | images `api` (also the worker, 898 MB), `admin` (78 MB), `portal` (78 MB) built; API container healthy; worker container `--once all` → 3× SUCCEEDED; long-running worker healthcheck healthy and graceful SIGTERM exit 0; API smoke: analytics 401 without token, overview/scans/helmets/risk-alerts 200, public emergency + verify 200 for a helmet with an active risk signal, unknown token 404; production refuses `TRUST_PROXY=true` and a missing proxy |

## Open decisions

1. **Thresholds** — defaults are conservative guesses; tune on real traffic (all env vars).
2. **Scan detail retention** — 180 days by default; confirm against the privacy policy.
3. **Owner notifications** — none today by requirement. Possible later: opt-in "your QR was
   scanned" for LOST/STOLEN helmets only.
4. **QR replacement process** — COMPROMISED needs an operations path (ship a new secure label,
   link via the Phase 3 replacement flow). No remote "rotation" exists by design.
5. **Who may set COMPROMISED** — currently ADMIN and SUPER_ADMIN; SUPPORT can only work alerts.

## False positives (summary)

Crash scenes, group rides, shared networks/CGNAT, link-preview bots and resale checks are handled
by design (volume-only caps at MEDIUM, bots excluded, verify needs a baseline multiple, copied-QR
needs corroboration). Details and tests: [RISK-ENGINE](RISK-ENGINE.md#false-positives-and-why-the-rules-look-like-this).

## Technical debt

- Risk evaluation issues ≈ 20 small statements per _flagged_ helmet; fine for tens–hundreds of
  flagged helmets per run, batch it if that grows.
- Distinct visitors over several days are summed daily distincts (approximate); exact multi-day
  distincts would need HLL sketches in the aggregate.
- Source-level detection state lives in Redis; a Redis flush resets windows (alerts already
  written are kept).
- `helmet_scans` partitioning deferred with a documented threshold.
- Charts are a minimal in-house SVG component (no zoom/brush); fine for 30-day daily series.
