# Phase 8: Production acceptance, real-world launch, operational polish

Production has run on the VPS since the end of Phase 7. It is a **shared aaPanel server with
PM2**, without Docker ([PM2-DEPLOYMENT](PM2-DEPLOYMENT.md)). Phase 8 validates the product
end to end, fixes UX and operational gaps, and prepares a controlled pilot. No infrastructure
redesign, no AWS, no new business domains, **no new tables or migrations**.

## 1. Production health review (start of phase)

What could be verified from this environment was checked **read-only over public HTTPS**. SSH
is not reachable from the cloud sandbox, so the server-side checks are delivered as a read-only
report script to be run on the VPS.

| Check                                                                   | Result                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API readiness                                                           | `{"status":"ok","database":"up","redis":"up"}`: **PostgreSQL and Redis healthy**                                                                                                                   |
| API liveness (portal and api hosts)                                     | 200                                                                                                                                                                                                |
| Portal / admin / emergency page / verify                                | load, 200                                                                                                                                                                                          |
| Unknown QR                                                              | `/public/emergency` 404 `HELMET_NOT_FOUND` (no detail leak); `/public/verify` `NOT_VERIFIED`                                                                                                       |
| Internal metrics                                                        | 404 on the portal and api hosts                                                                                                                                                                    |
| HTTP → HTTPS                                                            | 301                                                                                                                                                                                                |
| CORS                                                                    | no `Access-Control-Allow-Origin` for a foreign origin                                                                                                                                              |
| Security headers                                                        | HSTS (1 y, subdomains), CSP per surface (`default-src 'none'` on `/e/`), `X-Frame-Options DENY`, `nosniff`, Permissions-Policy, COOP, Referrer-Policy (`no-referrer` on `/e/`), `noindex` on `/e/` |
| Deployed code                                                           | the Phase 7 + PM2 commit: production still shows the pre-Phase-8 message wording                                                                                                                   |
| Worker jobs, migrations, backups, disk, logs, Postgres, Redis internals | **run `sudo /opt/ozzohelmets/scripts/ozzo-health-report.sh` on the VPS** (§10); not verifiable from here                                                                                           |

No production data was modified for these checks.

## 2. Test fixtures in production

Acceptance testing uses a dedicated model, never customer helmets
([manufacturing runbook](runbooks/manufacturing.md#internal-acceptance-test-helmets)):

- **Model:** `OZZO INTERNAL TEST`, SKU **`OZZO-INTERNAL-TEST`**.
- **Batches:** note `TEST-ACCEPTANCE-001`, `-002`, …

A new `isTest` column was **not** added. The model SKU is the marker
(`ANALYTICS_EXCLUDED_MODEL_SKUS`, default `OZZO-INTERNAL-TEST`). It keeps test helmets out of
platform analytics, is invisible on public pages, and needs no migration. Risk alerts caused by
staff scans close with **Dismiss as internal acceptance test**, kept in history and the audit log.

## 3. Customer journey: findings and fixes

The full journey was run end to end against the current code (local stack, Playwright on
emulated phones, `e2e/tests/phase8-acceptance.spec.ts`). The journey: admin creates model and
batch, generate, export, mark printed, open QR, Activation PIN, email, password, Recovery Code,
emergency profile, contact, privacy, enable, scan from another phone, verify, warranty, logout,
login, manage helmet. On production it must be repeated on real phones with the test model
(release checklist §4).

| Finding                                                                                          | Fix                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activation and emergency setup had **two different progress bars** (3 steps, then "Step n of 5") | One `SetupProgress` across both: Verify helmet → Create account → Emergency details → Emergency contact → Privacy → Finish ("Step n of 6"). Skips "Create account" when adding a helmet to an existing account                                                                                              |
| The end of setup said "Your helmet emergency profile is active." and nothing else                | Factual summary: Helmet ID, emergency profile Active, number of emergency contacts, QR emergency sharing On/Off, and buttons View my helmet, View emergency page, Copy Helmet ID. No marketing language                                                                                                     |
| After activation, a **second helmet** sent the customer through the whole emergency setup again  | If the profile is already set up, the CTA is "Turn on sharing for this helmet" (helmet page)                                                                                                                                                                                                                |
| Dashboard: about 10 cards of equal weight; emergency status was a small label                    | Order: **Emergency protection** status first ("Emergency information is not active yet." + **Complete emergency setup**, or "active · shown on n of m helmets · k contacts"), then safety warnings, my helmets, profile completion, warranty, account security, activity. Duplicate "Quick actions" removed |
| Helmet cards showed the account-wide profile status, not whether **this helmet** shares          | Cards and detail show "Emergency sharing on/off" for that helmet; model name first, Helmet ID second; "View helmet"                                                                                                                                                                                         |
| Helmet detail mixed identity, actions and timeline in one card                                   | Sections: Emergency protection, Identity, Warranty, Ownership, Lifecycle (actions + history), QR code and activity                                                                                                                                                                                          |
| Credential names inconsistent ("activation PIN", "recovery code", "transfer code"…)              | One vocabulary in portal, admin and API messages: **Helmet ID, Activation PIN, Customer ID, Recovery Code, Transfer Code, Recovery Grant**. The Recovery Code screen says "This code can recover your account if you forget your password. It is not your helmet's Activation PIN."                         |
| Wrong PIN: "That activation PIN is incorrect…"; unknown QR: "This QR code is not recognised."    | "The Helmet ID or Activation PIN could not be verified…"; "We could not verify this Helmet ID." (also on the public page)                                                                                                                                                                                   |
| Empty states (no helmets, no warranty, no activity) were one-liners                              | Explain what to do next, with the action                                                                                                                                                                                                                                                                    |
| Account page section titles were not headings                                                    | Semantic `h2` headings                                                                                                                                                                                                                                                                                      |

**Skipped setup** (spec item 10) behaves as required: the helmet stays **ACTIVATED** (not
ACTIVE); the dashboard says "Emergency information is not active yet." with "Complete
emergency setup"; the card says "Emergency sharing off"; a public scan shows only the neutral
"has not shared emergency information" notice. Covered by the Phase 8 Playwright spec.

**Warranty** (spec item 29) already matched the requested flow (purchase date, channel, seller,
optional invoice and proof, review, register) with no dealer system. Unchanged.
**Account page** (item 30) already had the requested content and order with no helmet controls.

## 4. Public pages

- **Emergency page order** (spec item 24): status warning, name and photo, blood group, **medical
  conditions, allergies, medications, emergency contacts, other notes**, then product identity.
  Phase 2 had contacts right after allergies; the spec's order is now used.
- **Call buttons:** "Call Rajesh" with the number underneath (`+91…`), at least 56 px tall,
  "Provided by helmet owner", never "verified". The accessible name includes the full name and
  number. The emergency-services button (`VITE_EMERGENCY_NUMBER`, default 112) stays in the
  sticky call bar and is static HTML, usable before any data loads.
- **Verify page** wording already said "Product identity verified: this Helmet ID exists in the
  manufacturer's registry. This confirms the registered identity, not the physical helmet
  itself." Kept. It stays secondary (below emergency facts; its own `/verify/` URL).
- **Real-device review (emulated):**
  - Tested on iPhone SE (375 × 667), Pixel 7 and iPhone 15 Pro Max profiles in Chromium.
  - Facts appear in the required order, call buttons are large and dial `tel:+91…`, there is no
    horizontal overflow, and the page loaded in under 5 s on the local stack.
  - **Not covered:** real Safari/WebKit, real devices, outdoor brightness. These are on the
    release checklist.
- **Network conditions:**
  - Slow 3G emulation (400 ms RTT, 400 kbit/s): the call bar is visible immediately and the
    profile appears. 12.3 s was measured against the **Vite dev server** (dozens of unbundled
    modules), so it is not representative.
  - The production bundle for `/e/` is **≈ 8 KB gzipped** in total: HTML 1.5 KB, JS 4.5 + 0.7 +
    0.5 KB, CSS 1.6 KB, plus one JSON request.
  - API unreachable: a clean error with **Try again**, and the call bar still works.
  - A Redis outage was verified in Phase 7: emergency data is served from PostgreSQL.
  - Measuring production in a browser from this sandbox failed (the egress proxy breaks
    Chromium's TLS); measure on a real phone (release checklist).

## 5. Admin and manufacturing

- **Activation PIN state** (spec items 15–16), derived from the escrow row and the export audit
  trail:

  | State       | Shown as                       | Meaning                                                                |
  | ----------- | ------------------------------ | ---------------------------------------------------------------------- |
  | `AVAILABLE` | Available for manufacturing    | unused; plaintext in escrow; batch not exported yet                    |
  | `EXPORTED`  | Unused · exported for printing | unused; batch CSV exported (shows when); escrow purged on mark printed |
  | `PURGED`    | Unused · escrow purged         | unused, but nobody can retrieve the PIN any more                       |
  | `CONSUMED`  | Consumed                       | used to activate (works once)                                          |

  **PIN reveal:** none exists. The only plaintext path remains the manufacturing CSV, which
  needs `export:manufacturing` (SUPER_ADMIN, ADMIN), is audited, and has empty PINs after
  escrow purge. Admin APIs never return a PIN; the integration test asserts this for the helmet
  detail.

- **Batch page:**
  - a workflow strip (Generate helmets → Export manufacturing CSV → Print labels & mark printed
    → Helmets activated) with a one-line "next step";
  - CSV export count and last export time;
  - per-status counts (generated, printed, activated, active, lost/stolen, not yet activated).
- **Batch list:** search matches batch code, model name or SKU; filters for generation status,
  print status and manufacturing date range; empty state distinguishes "no batches" from "no
  match".
- **Helmet search** (one box):
  - Helmet ID (exact, any case or spacing, or a fragment), serial, batch code, model or SKU;
  - owner **email or Customer ID** only for roles with `customers:read`; for others those terms
    match nothing, so there is no email-to-helmet probing;
  - no medical data in results.
- **Support** (items 21–22): the customer page gets quick links (Helmets, Warranty, Security
  events, Support actions). Sign out all sessions and Restore sit apart from **Restrictive
  actions** (Suspend, Lock) in a separate bordered group. Recovery Grant (SUPER_ADMIN) and Mark
  deleted stay separate cards.
- **Analytics** (items 44–46): the test model is excluded from platform aggregates and overview
  headline numbers ([ANALYTICS](ANALYTICS.md#internal-test-helmets-phase-8)).

## 6. Mobile and accessibility

- A 360 px audit of dashboard, helmets, profile, contacts, privacy, warranty, account and helmet
  detail found **no horizontal overflow** (automated check in the Phase 8 spec).
- Accessibility changes:
  - the progress indicator is an `ol` with `aria-current="step"` and screen-reader step labels;
  - semantic headings on the account page, helmet detail sections and dashboard;
  - call buttons have descriptive accessible names;
  - the contacts section is labelled;
  - switch inputs keep their visible labels.
- **Not done:** an automated axe audit (no axe dependency in the repo) and a screen-reader pass
  on real devices. Recommended during the pilot.

## 7. Security smoke on production (non-destructive)

| Check                                                                     | Result                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wrong login                                                               | 401 `INVALID_CREDENTIALS`, generic message                                                                                                                                                                                                                                                                                                       |
| Wrong Recovery Code                                                       | 401, generic message                                                                                                                                                                                                                                                                                                                             |
| Wrong PIN / unknown helmet                                                | 409 `HELMET_NOT_ACTIVATABLE`, generic                                                                                                                                                                                                                                                                                                            |
| Garbage or expired bearer token                                           | 401                                                                                                                                                                                                                                                                                                                                              |
| Refresh without the CSRF header                                           | 403                                                                                                                                                                                                                                                                                                                                              |
| Admin API without token                                                   | 401                                                                                                                                                                                                                                                                                                                                              |
| Warranty proof without auth                                               | 401                                                                                                                                                                                                                                                                                                                                              |
| Spoofed `CF-Connecting-IP`                                                | **rejected by Cloudflare** (error 1000) before reaching the origin                                                                                                                                                                                                                                                                               |
| Spoofed `X-Forwarded-For` / `X-Real-IP`                                   | request served normally; the aaPanel edge **overwrites** both with the Cloudflare-verified address and strips `CF-Connecting-IP` (`deploy/aapanel/snippets/proxy.conf`; real IP only from Cloudflare ranges via `realip.conf`). The API trusts loopback only. Confirmed from the config; there is no way to observe the recorded IP from outside |
| Revoked session, cross-account access, private proof for another customer | covered by the integration suites (authorization, warranty, phase5); on production they need two test accounts (release checklist)                                                                                                                                                                                                               |

## 8. Performance

No load test was run against production from here: it is a shared server, and the sandbox can't
reach it except through an intercepting proxy that adds about 1 s per request. Phase 8 adds no
query on the public emergency path. The admin changes add, per page view:

- one audit-log lookup on the helmet detail, using the `(entity_type, entity_id)` index;
- one grouped audit query per batch list page;
- two grouped helmet counts on the batch detail.

The Phase 7 baselines remain the reference (emergency cached p95 4.7 ms at 200/s; login about
5–7/s per API process). After deploying, run the moderate k6 profile from Phase 7 against the
internal test helmet off-peak, then compare.

## 9. Pilot, release and SOPs

- [RELEASE-CHECKLIST](RELEASE-CHECKLIST.md): CI, backup, migrations, worker, monitoring, disk,
  tag, changelog, smoke, real-device QR, support and manufacturing readiness.
- [CHANGELOG](../CHANGELOG.md): **v1.0.0** capability summary.
- [PILOT](PILOT.md): stages (internal test → 10–20 internal riders → 50–100 pilot customers →
  rollout), metrics (`scripts/pilot-metrics.sql`, read-only, counts only, test model excluded),
  and the feedback log process.
- [Support SOP](runbooks/support.md): the six identifiers and credentials, side by side.
- [Manufacturing runbook](runbooks/manufacturing.md): test helmets and the physical PIN options
  (scratch card, sealed card, protected sticker, packaging). This decision stays open.

## 10. Server-side verification (to run on the VPS)

```bash
sudo /opt/ozzohelmets/scripts/ozzo-health-report.sh 2>&1 | tee /tmp/ozzo-health.txt
```

Read-only. It covers:

- version and PM2 processes;
- local and Cloudflare health;
- migrations (applied, failed);
- **worker** heartbeat, plus last success, runs and failures per job in 24 h;
- **backups**: timer status, last run result, latest set checksums and `pg_restore --list`, age;
- disk usage by area;
- Postgres size, connections, long transactions, lock waits, cache hit, largest tables with
  seq/idx scans;
- Redis memory, evictions, rejections, clients, keys, latency;
- 24 h log counts by level and HTTP status, with no log lines printed;
- host memory and CPU.

It never prints secrets.

## 11. Verification

| Gate                                                        | Result                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Format / lint / typecheck                                   | pass                                                                                                          |
| Unit                                                        | 303 passed                                                                                                    |
| Integration (`--runInBand`)                                 | **188 passed** (19 suites, incl. new `phase8-operations`)                                                     |
| Playwright                                                  | **55 passed** in one run (49 + 6 new Phase 8 acceptance tests)                                                |
| `pnpm build`                                                | pass                                                                                                          |
| Prod compose (+ profiles), Docker edge `nginx -t`, promtool | pass                                                                                                          |
| aaPanel nginx configs (`nginx -t` with production paths)    | pass (warning: `listen … http2` deprecation, kept for older aaPanel nginx)                                    |
| shellcheck (all scripts)                                    | pass                                                                                                          |
| Migrations / drift                                          | no new migrations; dev DB current                                                                             |
| Dependency audit                                            | 0 critical; same 2 high / 1 moderate as Phase 7 (Prisma CLI `deepmerge-ts`; jest-only `braces`, `sprintf-js`) |
| Production smoke (`scripts/production-smoke.sh`)            | **SMOKE OK** (15 checks)                                                                                      |
| Production security smoke                                   | pass (§7)                                                                                                     |

## 12. Remaining operational decisions

1. **Physical Activation PIN format**: scratch card, sealed card, sticker or packaging. Open;
   a sealed card is enough for the pilot.
2. **Account deletion**: currently disables the account and its public information without
   erasing data. Retention and erasure rules are needed before public customers.
3. **ClamAV for warranty proofs**: not installed on the shared server. Decide before public
   customers upload proofs at volume.
4. **Origin lock vs Cloudflare fallback**, and the alert destination for the external uptime
   monitor.
5. **Shared-host hygiene** (server owner):
   - aaPanel `pg_hba` has `trust` for 127.0.0.1;
   - UFW still allows 5432;
   - plain FTP is open;
   - the root password and an SSH private key were shared in chat and should be rotated.

## 13. Known issues and limits

- **No production deployment of Phase 8 yet.** Production still runs the Phase 7 + PM2 code.
  Deploy with the release checklist.
- Not verifiable from this environment: server-side health (§10), backup timer runs, worker
  history on production, a monitoring alert actually being delivered, and real-device / real
  Safari testing. All are on the release checklist.
- **Offsite backup** and **external uptime monitoring** are still not configured
  (launch-critical).
- An automated accessibility audit (axe) is not in the toolchain.
- The Phase 6 Playwright test asserted a helmet in a global top-10 list. That broke on
  long-lived dev databases and is now asserted on Helmet activity instead.
- `listen … http2` deprecation warning in the aaPanel vhost files (harmless; kept for older
  aaPanel nginx).
- "New customers" in analytics includes accounts created during acceptance testing, because
  accounts are not tied to a model.

## 14. Readiness

**READY WITH CONDITIONS for the pilot.**

- **Stage 0–1 (internal, 10–20 helmets):** ready once Phase 8 is deployed through the release
  checklist, the server health report is clean, and the physical QR test on printed labels
  passes.
- **Stage 2 (public pilot customers):** additionally needs **OFFSITE BACKUP** with a tested
  restore, **external uptime monitoring** with a working alert, the privacy notice and deletion
  decision, and the ClamAV decision.
