# QR abuse & copied-code detection

How the platform notices misuse of public QR pages while keeping **emergency access the highest
priority**. Software can only observe requests for tokens; it **cannot prove a physical helmet is
counterfeit**. All wording is "Suspicious scan activity", "Possible copied QR", "Review
recommended".

## Principles

1. Emergency pages are never disabled by analytics. Helmets already in the public cache are always
   served, even to a flagged source. No CAPTCHA.
2. Detection is deterministic and explainable (counts vs thresholds).
3. No IPs, IP hashes, attempted tokens or user agents in alerts; sources are an opaque
   `sourceRef` (first 12 hex chars of `sha256("risk-source:" + ipHash)`).
4. Humans decide. Alerts and QR integrity are admin-only; customers are not notified automatically.
5. No fake "QR rotation": a printed label cannot change remotely. Replacement labels are an
   operations process.

## Layers

| Layer                      | Where                  | Detects                                                                                                           | Response                                                                                                                                                                                    |
| -------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-IP miss budget (Ph. 5) | API, Redis             | many unknown/malformed tokens from one source                                                                     | flag the source: cached helmets still served, `PUBLIC_UNCACHED_LIMIT_WHEN_FLAGGED` uncached lookups per window, then 429                                                                    |
| Token enumeration          | API, Redis             | ≥ `ENUMERATION_INVALID_TOKEN_LIMIT` misses / window                                                               | `TOKEN_ENUMERATION` alert (once per source per window), counts only                                                                                                                         |
| Global miss burst (Ph. 5)  | API, Redis             | > `PUBLIC_GLOBAL_MISS_LIMIT_PER_MINUTE` misses across sources                                                     | per-IP budgets tightened to ¼; one `SYSTEM_RATE_LIMIT_SPIKE` alert per hour                                                                                                                 |
| Valid-token scraping       | API, Redis HyperLogLog | one source reaching > `VALID_TOKEN_SCRAPE_LIMIT` distinct **valid** helmets / `VALID_TOKEN_SCRAPE_WINDOW_SECONDS` | flag source (as above) + `VALID_TOKEN_SCRAPING` alert (MEDIUM); above `× VALID_TOKEN_SCRAPE_BLOCK_MULTIPLIER` uncached lookups refused (HIGH alert). Cached emergency pages stay available. |
| Per-helmet patterns        | worker, PostgreSQL     | volume, distinct visitors, churn, verification spikes, report correlation                                         | signals, assessment, `HELMET_SCAN_ANOMALY` / `HIGH_PUBLIC_SCAN_VOLUME` alert (RISK-ENGINE.md)                                                                                               |

The HyperLogLog stores only hashed membership (no list of helmets per source). Re-scanning the
same helmet many times never counts as scraping.

## Alerts

`risk_alerts` — `type, status, priority, helmet | sourceRef, dedupKey, summary, reasons,
observed/threshold, occurrences, first/last seen, assignee, resolutionReason, resolvedAt/By`.

| Type                      | Subject  | Raised by                                 |
| ------------------------- | -------- | ----------------------------------------- |
| `HELMET_SCAN_ANOMALY`     | helmet   | risk evaluation (visitor/verify patterns) |
| `HIGH_PUBLIC_SCAN_VOLUME` | helmet   | risk evaluation (volume only)             |
| `TOKEN_ENUMERATION`       | source   | API miss path                             |
| `VALID_TOKEN_SCRAPING`    | source   | API valid-lookup path                     |
| `SYSTEM_RATE_LIMIT_SPIKE` | platform | global miss burst                         |

**Lifecycle:** `OPEN → ACKNOWLEDGED ⇄ INVESTIGATING → RESOLVED | DISMISSED` (OPEN may go straight
to any later state). Resolving or dismissing requires a reason and also marks the helmet's
assessment reviewed. RESOLVED/DISMISSED are final. Every change is audited
(`risk_alert.acknowledged|investigating|resolved|dismissed|assigned`); individual scans are not.

**Deduplication:** a partial unique index allows one open alert per `dedupKey`
(`helmet:<id>:volume|anomaly`, `source:<ref>:enumeration|scraping`, `system:miss-burst`); new
observations increment `occurrences`, keep the max priority and observed value. API paths raise
alerts fire-and-forget behind a Redis `SET NX` gate, so a burst writes at most one row update per
window. **Suppression:** after resolve/dismiss, the same key stays quiet for
`RISK_ALERT_SUPPRESS_HOURS` (24) unless the observed value at least doubles.

## QR integrity

`helmets.qr_integrity_status`: `NORMAL · UNDER_REVIEW · COMPROMISED`, plus note and timestamp.
Changed only by `qr-integrity:manage` (SUPER_ADMIN, ADMIN), note required, audited
(`helmet.qr_integrity.changed`), public caches invalidated. Never automatic, never changes
lifecycle status, never affects the emergency page. When `COMPROMISED`, the public verification
page shows a neutral notice:

> This QR code has been reported as possibly copied. Check that the Helmet ID printed inside the
> helmet matches the one shown here, and contact support if it does not.

## Client IP correctness

Per-source detection depends on the real client IP. Production refuses to start with
`TRUST_PROXY=true` (spoofable `X-Forwarded-For`) and, unless
`REQUIRE_TRUSTED_PROXY_IN_PRODUCTION=false`, without a trusted proxy (hop count/CIDRs) or
`TRUST_CLOUDFLARE`. At runtime the API logs an error (rate-limited) when forwarded headers arrive
while no proxy is trusted. See DEPLOYMENT.md.

## Tests

`public-abuse.spec.ts` (enumeration, scraping flag → block, repeat scans not scraping, burst alert),
`risk-alerts.spec.ts` (transitions, dedup, suppression), `phase6-analytics.e2e-spec.ts`
(enumeration and scraping over HTTP with cached emergency page still served, alert workflow,
QR integrity with emergency page unaffected), Playwright `phase6-analytics.spec.ts`.
