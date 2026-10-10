# Changelog

Format: one entry per production release, grouped by capability. Commit history is in git.
Release procedure: [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md).

## v1.0.0: first production release (pilot)

**Status:** release candidate. Tagged after the release checklist (deploy, smoke test, real-device
QR test) passes on production. Record the deployed SHA and date in the table below.

| Field            | Value                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------- |
| Git tag / SHA    | `v1.0.0` / _filled in when tagged_                                                     |
| Release date     | _filled in when deployed_                                                              |
| Latest migration | `20261010090000_phase7_worker_heartbeat` (no Phase 8 migrations)                       |
| Deployment       | single VPS, PM2 + aaPanel nginx, Cloudflare ([PM2-DEPLOYMENT](docs/PM2-DEPLOYMENT.md)) |

### What the platform does

- **Manufacturing:**
  - helmet models and batches;
  - background generation of unique identities (Helmet ID, serial, public QR token, one-time
    Activation PIN);
  - QR and Code128 labels;
  - audited manufacturing CSV with an encrypted, short-lived PIN escrow, purged on "mark
    printed";
  - batch workflow, export history and per-status counts;
  - explicit Activation PIN state on every helmet.
- **Activation and accounts:**
  - scan the QR (or enter the Helmet ID), enter the Activation PIN, create an email + password
    account with a Customer ID and a one-time Recovery Code;
  - one guided setup flow with a progress indicator;
  - additional helmets join the same account with their PIN.
- **Emergency profile:**
  - name, photo, blood group, conditions, allergies, medications and notes, with medical fields
    encrypted at rest;
  - up to five emergency contacts;
  - per-field public visibility and a per-helmet sharing switch;
  - the public page puts emergency facts first, with large call buttons showing the number and
    a configurable emergency number;
  - works when Redis is down, and is never login-throttled.
- **Ownership lifecycle:**
  - Transfer Codes, claim by the new owner;
  - lost / stolen / damaged / retired states with public notices;
  - support-linked replacements.
- **Warranty:** registration with purchase date, channel, seller and optional invoice/proof,
  coverage from the model's warranty months, and owner-only proof downloads.
- **Product verification:** "Product identity verified: this Helmet ID exists in the
  manufacturer's registry", plus public product reports and a neutral notice for QR codes
  marked as possibly copied.
- **Customer account:** sessions and sign-out of other devices, security activity, password
  change, Recovery Code rotation, email change, data export and deletion request.
- **Support:**
  - one-box search (Helmet ID, serial, batch, model, owner email or Customer ID with
    permission);
  - customer page with helmets, warranty, security events and separated restrictive actions;
  - SUPER_ADMIN Recovery Grants;
  - privacy requests and product-report triage;
  - full audit log.
- **Analytics:**
  - daily aggregates built by a worker;
  - scan analytics;
  - deterministic, explainable risk signals and deduplicated alerts with a human workflow;
  - enumeration and scraping detection;
  - retention;
  - internal test helmets (model `OZZO-INTERNAL-TEST`) are excluded.
- **Operations:**
  - health live/ready, Prometheus metrics (token, hidden at the edge), worker heartbeat and
    System status;
  - daily local backups with checksums;
  - production smoke test and server health report scripts;
  - pilot metrics query;
  - runbooks for incidents, disaster recovery, manufacturing, support and compromised QR codes.

### Known limitations at v1.0.0

- **OFFSITE BACKUP REQUIRED FOR PRODUCTION:** backups are local to the VPS until an offsite copy
  is configured and restore-tested.
- External uptime monitoring must be configured outside the VPS.
- Single VPS, no high availability.
- Account deletion disables the account and its public information, but does not erase data
  yet.
- The physical Activation PIN format (scratch card, sealed card, sticker) is not finalised.
