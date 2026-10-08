# Risk engine

Deterministic, explainable rules over **scan metadata, verification patterns and product
reports** — never medical data. No machine learning, no opaque scores.

> **Suspicious scan activity does not prove a physical helmet is counterfeit.** Output is review
> guidance for a human ("Review recommended"). The engine never labels a helmet counterfeit, fake
> or fraudulent, never changes `HelmetStatus` or QR integrity, never disables emergency access and
> never notifies customers.

Code: `apps/api/src/modules/analytics/domain/risk-rules.ts` (pure functions, unit-tested) and
`risk-evaluation.service.ts` (persistence), run by the worker job `risk.evaluate`.

## Inputs

One grouped query over the last 24 h of non-synthetic, non-bot scans, for helmets with at least
`RISK_MIN_SCANS_FOR_EVALUATION` scans: scans in 1 h / 24 h / 15 min, distinct IP hashes in 1 h and
15 min, verify scans in 24 h. Plus the 7-day verify baseline from `helmet_scan_daily` and product
reports in the last 30 days.

## Signals

| Signal                         | Fires when (defaults, all configurable)                                                                                                 | Weight                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `HIGH_SCAN_VOLUME`             | > `RISK_HIGH_SCAN_HOURLY` (50) / 1 h or > `RISK_HIGH_SCAN_DAILY` (200) / 24 h                                                           | 15; 25 when ≥ 2× (MEDIUM) |
| `HIGH_UNIQUE_VISITOR_COUNT`    | > `RISK_UNIQUE_IP_HOURLY` (20) distinct IP hashes / 1 h                                                                                 | 25                        |
| `RAPID_IP_CHURN`               | > `RISK_IP_CHURN_15MIN` (10) distinct hashes / 15 min **and** ≥ `RISK_IP_CHURN_MIN_RATIO` (0.8) of scans from different hashes          | 20                        |
| `ABNORMAL_VERIFY_ACTIVITY`     | > `RISK_VERIFY_DAILY` (30) verify scans / 24 h **and** > `RISK_VERIFY_BASELINE_MULTIPLIER` (5) × the 7-day daily baseline (floor 1/day) | 20                        |
| `PRODUCT_REPORT_CORRELATION`   | ≥ 1 product report in 30 days, **only alongside** another signal                                                                        | 10 per report, max 20     |
| `QR_SHARED_OR_COPIED_POSSIBLE` | (unique visitors **or** churn) **and** (abnormal verify **or** product reports)                                                         | 20                        |

Thresholds are strict (`>`): a value exactly at a threshold does not fire.

## Score and level

`score = min(100, Σ weights of distinct signals)` →

| Score  | Level    |
| ------ | -------- |
| 0      | NONE     |
| 1–24   | LOW      |
| 25–49  | MEDIUM   |
| 50–74  | HIGH     |
| 75–100 | CRITICAL |

Guards: **a single signal never exceeds MEDIUM**; **CRITICAL needs ≥ 3 distinct signals**. Every
assessment carries its reasons (`type, label, observed, threshold, weight, detail`), shown verbatim
in the admin UI, e.g. "High scan volume (+15) — 60 public scans in 1 hour (threshold 50)".

## Persistence

- `helmet_risk_signals` — one `ACTIVE` row per (helmet, type) (partial unique index), updated in
  place on each observation; `CLEARED` after `RISK_SIGNAL_CLEAR_AFTER_HOURS` (24) without
  re-observation. Metadata holds counts only, never IP hashes.
- `helmet_risk_assessments` — current level, score, reasons, first/last detected, and the human
  resolution (set when an alert for the helmet is resolved/dismissed; new activity re-opens it).
- Alerts — see QR-ABUSE-DETECTION.md. Volume-only patterns raise `HIGH_PUBLIC_SCAN_VOLUME`;
  visitor/verification patterns raise `HELMET_SCAN_ANOMALY`. Priority = level.

## False positives (and why the rules look like this)

| Legitimate situation                                    | Effect                                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Crash scene: paramedics and bystanders scan repeatedly  | Volume from few sources → `HIGH_SCAN_VOLUME` only → LOW/MEDIUM. Never HIGH alone.                         |
| Group ride / club event: many riders scan one helmet    | Many distinct visitors (MEDIUM). Becomes "possible copied QR" only with abnormal verification or reports. |
| Shared network / CGNAT / hospital Wi-Fi                 | One IP hash for many people — lowers visitor counts, so it can't inflate risk.                            |
| Owner tests the QR, social media post of a helmet photo | Usually volume only → LOW; clears after 24 h quiet.                                                       |
| Link-preview bots (WhatsApp, Slack, crawlers)           | Classified `BOT`, excluded from risk and public counts.                                                   |
| Resale buyer verifying several times                    | Verify rule needs both an absolute floor (30/day) and 5× the helmet's own baseline.                       |

Unit tests (`risk-rules.spec.ts`) and integration tests (`phase6-analytics.e2e-spec.ts`) pin these
scenarios, including "crash scene stays below HIGH" and "busy emergency is never CRITICAL".

## Tuning

All thresholds are environment variables (`.env.example`, "Analytics, risk signals and the
worker"). Raising a threshold only reduces signals; existing active signals clear on their own
after the clear-after window.
