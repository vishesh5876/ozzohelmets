# Pilot plan

Start small, watch closely, widen only when the numbers and the feedback say so. Related:
[RELEASE-CHECKLIST](RELEASE-CHECKLIST.md) · [LAUNCH-CHECKLIST](LAUNCH-CHECKLIST.md) ·
[support SOP](runbooks/support.md) · [manufacturing runbook](runbooks/manufacturing.md).

## Stages

| Stage | Who                                    | Helmets | Length (guide) | Move on when                                                                                   |
| ----- | -------------------------------------- | ------- | -------------- | ---------------------------------------------------------------------------------------------- |
| 0     | Staff, test model `OZZO-INTERNAL-TEST` | 5–10    | 1 week         | physical QR test passed; every step of the journey done on real phones; no open SEV1/SEV2      |
| 1     | Internal riders (staff, family)        | 10–20   | 2 weeks        | ≥ 90 % of activations complete without help; no data or privacy issue; support load manageable |
| 2     | Pilot customers (one region or shop)   | 50–100  | 4–6 weeks      | targets below met for 2 consecutive weeks; offsite backup and uptime monitoring live           |
| 3     | Broader rollout                        | batches | ongoing        | release checklist per release; weekly metrics review                                           |

Stage 2 and later use real (non-test) helmet models. Never pause emergency pages for a stage
change.

## Metrics (weekly)

Run [`scripts/pilot-metrics.sql`](../scripts/pilot-metrics.sql) on the server (read-only, counts
only, test model excluded) with the pilot start date. It reports:

| Metric                             | Source                                              | Target (stage 2)                          |
| ---------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| Activation rate                    | activated / printed-or-later helmets                | track; early pilots have unsold stock     |
| Emergency profile completion       | new owners with the emergency profile enabled       | ≥ 70 %                                    |
| Emergency sharing                  | helmets ACTIVE / activated helmets                  | ≥ 70 %                                    |
| Time from activation to sharing    | median and p90 minutes (status history)             | median < 15 min                           |
| Owners with an emergency contact   | owners with ≥ 1 active contact                      | ≥ 80 %                                    |
| Warranty registration rate         | registered / activated                              | track                                     |
| Failed Activation PIN attempts     | `helmet.activation.failed` / `.locked` audit events | < 1 per activation; investigate lockouts  |
| Failed logins, password recoveries | `customer.login.failed`, `customer.recovery.*`      | track trend                               |
| Support Recovery Grants            | `customer.recovery_grant.issued`                    | < 5 % of customers                        |
| QR activity and review signals     | scan aggregates, risk alerts, product reports       | every alert triaged within 2 working days |
| Customer-reported problems         | the feedback log below                              | none open > 1 week without an owner       |

Medical content is never part of any metric. Admin → Analytics shows the same numbers with test
helmets excluded.

## Feedback process

No product feature is needed. Support keeps one shared log (spreadsheet or ticket tracker) with
one row per report:

| Column                  | Values                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date, source            | phone / email / in person / staff test                                                                                                                           |
| Category                | activation issue · QR scanning issue · emergency profile confusion · password / recovery issue · warranty issue · UI issue · manufacturing / label issue · other |
| Helmet ID / Customer ID | identifiers only: no medical details, no passwords or codes                                                                                                      |
| What happened           | the customer's words, briefly                                                                                                                                    |
| Severity                | blocker (could not complete the journey) · annoying · suggestion                                                                                                 |
| Owner, status, outcome  | who looks at it; open → fixed / won't fix / needs decision                                                                                                       |

Weekly 30-minute review: metrics, the top five feedback categories, and decisions (fix now,
backlog, document). Blockers in the emergency path are handled as incidents
([INCIDENT-RESPONSE](INCIDENT-RESPONSE.md)).

## Before stage 1

- [ ] Release checklist completed for the pilot release (tagged, deployed, smoke-tested).
- [ ] Physical QR test on printed labels ([LAUNCH-CHECKLIST](LAUNCH-CHECKLIST.md#physical-qr-test-blocker)).
- [ ] Support team trained on the [support SOP](runbooks/support.md), especially the six
      identifiers and credentials.
- [ ] Feedback log created; weekly review in the calendar.
- [ ] Interim physical PIN format chosen for the pilot (sealed card is enough).

## Before stage 2 (public customers)

- [ ] **Offsite backup configured and a restore from it tested.**
- [ ] **External uptime monitoring** on the test helmet's emergency page, alerting a phone.
- [ ] Privacy notice published; account-deletion behaviour decided (see DATA-INVENTORY).
- [ ] Stage 1 targets met.
