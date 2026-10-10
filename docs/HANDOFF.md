# Handoff (paste into a new session): Helmet ID platform (Ozzo Helmets): Phases 1–7 done, VPS deployment next

You are continuing work on the repository `vishesh5876/ozzohelmets`. All work so far is on branch
**`claude/epic-gates-7picyo`**. Check it out first and keep developing and pushing there
(`git push -u origin claude/epic-gates-7picyo`). Do not open a pull request unless I ask.

The repository docs are the source of truth. Read them before acting:

- `docs/PHASES.md`
- `docs/PHASE-7.md`
- `docs/VPS-DEPLOYMENT.md`
- `docs/DISASTER-RECOVERY.md`
- `docs/LAUNCH-CHECKLIST.md`
- `docs/runbooks/`

## What the product is

A QR-based helmet identity and emergency-information platform:

- Each manufactured helmet gets a Helmet ID, a public QR token, a one-time activation PIN and a
  serial number.
- A rider activates the helmet with QR + PIN, creates an account (email + password, plus a
  Customer ID and a recovery code) and fills in an emergency profile. Medical fields are
  AES-256-GCM encrypted.
- Anyone scanning the QR (`/e/<token>`) sees only the fields the owner chose to share.
- `/verify/<token>` shows product authenticity.

There are exactly three surfaces: **Admin console**, **Customer portal** and the **public QR
pages**. There is **no** dealer, distributor, partner, inventory, OTP or SMS architecture (by
decision, see ADR-001). **Emergency QR availability is the highest operational priority.**

## Stack

pnpm monorepo:

- `apps/api`: NestJS 11, Prisma 6.19, PostgreSQL 16, Redis (ioredis), Argon2id, sharp. The same
  image runs:
  - the API (`dist/main.js`);
  - the worker (`dist/worker.js`);
  - the CLI (`dist/cli.js`: `admin:bootstrap`, `encryption:status`, `encryption:rotate`).
- `apps/admin` and `apps/portal`: React 19 + Vite. The portal also serves `/e/` and `/verify/`.
- `packages/types`, `packages/ui`, `packages/api-client`.
- `e2e/` (Playwright) and `loadtest/` (k6).

## Phases (all complete and pushed)

1. **Foundation + manufacturing:**
   - admin auth (JWT + rotating refresh) and RBAC;
   - helmet models and batches;
   - async bulk identity generation;
   - QR/Code128 labels;
   - manufacturing CSV with an encrypted, short-lived PIN escrow (purged on "mark printed").
2. **Activation + emergency:** PIN activation, customer accounts, emergency profile with
   per-field visibility, public emergency page, recovery code.
3. **Ownership lifecycle:** transfer (code-based), lost/stolen/damaged/retire, replacement
   linking.
4. **Warranty + authenticity:** Customer ID, warranty registration and proof upload, product
   verification page, public product reports.
5. **Account and support:**
   - customer sessions, activity, export and deletion requests;
   - admin support view, recovery grants and privacy requests;
   - public-page hardening and QR abuse controls.
6. **Analytics:** daily aggregates built by a worker (advisory locks), deterministic risk
   signals and alerts, QR integrity marker, enumeration and scraping detection, retention.
7. **VPS production readiness** (see `docs/PHASE-7.md`).

### Phase 7 details

App:

- `/health/live` and `/health/ready`.
- Redis outage policy: public reads fail open from Postgres; auth fails closed with 503.
- Prometheus metrics behind `METRICS_TOKEN`.
- Worker DB heartbeat and an admin "System status" card.
- Argon2 concurrency limiter (`ARGON2_MAX_CONCURRENCY`=1, `ARGON2_MAX_QUEUE`=16).
- Hardened local file storage; optional ClamAV.
- Production config guards: the app refuses weak DB passwords, shared or dev secrets, wildcard
  or HTTP CORS, a non-HTTPS QR URL, and Swagger without opt-in.

Infrastructure:

- `docker-compose.prod.yml`: edge nginx + api, worker, admin, portal, postgres, redis; optional
  `monitoring` and `clamav` profiles.
- `deploy/nginx`, `deploy/monitoring`, `deploy/systemd`, `deploy/env/*.example`.
- Scripts:
  - `scripts/deploy-vps.sh` (backup → build → migrate → up → smoke checks; `--rollback`);
  - `scripts/compose.sh` (always use it instead of raw `docker compose`);
  - `scripts/backup.sh`, `scripts/restore.sh` (needs `--confirm <project>`),
    `scripts/restore-drill.sh`;
  - `scripts/vps-prepare.sh`, `scripts/update-cloudflare-ips.sh`.
- CI in `.github/workflows/ci.yml`. It never deploys.

Verified on a staging copy of the production compose stack:

| Check             | Result                                                                             |
| ----------------- | ---------------------------------------------------------------------------------- |
| Unit tests        | 302                                                                                |
| Integration tests | 184                                                                                |
| Playwright        | 49                                                                                 |
| Load tests        | Emergency cached p95 4.7 ms at 200/s; login capacity about 5–7/s per API container |
| Failure tests     | Redis, Postgres, worker, API restart/crash                                         |
| Restore drills    | Pass                                                                               |
| Dependency audit  | 0 critical                                                                         |
| CSP               | No violations                                                                      |

Status: **READY WITH CONDITIONS.** Open items:

- **OFFSITE BACKUP REQUIRED FOR PRODUCTION** (backups are local only);
- external uptime monitoring;
- real VPS/Cloudflare/TLS validation;
- physical QR label test;
- an offline copy of the keyrings held by two people;
- the account-deletion erasure decision (today deletion disables the account but erases nothing).

## Rules (keep following them)

- **No AWS** (ECS/EKS/RDS/S3/CloudFront/KMS/Terraform, and so on). Uploads stay on the **local
  VPS filesystem** behind the existing `FileStorageService` / `LocalStorageProvider`. S3 must
  never become a required dependency.
- Do not redesign working product features.
- Never throttle valid emergency access the way logins are throttled. Risk states never hide
  emergency information.
- Secrets only in restricted env files on the server (`/etc/helmet-platform/*.env`, mode
  600/640). Never commit them; nothing secret in compose YAML or the repo. One secret per
  purpose.
- Production: never `prisma migrate reset` or `prisma db push`. Never delete volumes. Never
  overwrite the production DB without explicit confirmation. Never edit applied migrations.
- Do not fabricate test or load numbers. Do not call the system disaster-safe with local-only
  backups.
- Before anything that can lock me out (SSH hardening, firewall changes) or that changes
  existing services on the server: show the plan and ask first.
- Commits end with the Co-Authored-By / Claude-Session lines given by the system. No model names
  in commits or files.

## Current task: deploy to my VPS

- **Server:** a Hostinger VPS. I will give you the address and credentials in chat. **Never write
  them to any file or commit them.**
- **Check SSH first:** run `nc -vz <server-ip> 22`. If this session can't SSH, tell me
  immediately. I will run the commands on my Mac and paste you the output.
- **Domains** (Cloudflare, proxied):
  - customer portal + QR pages = `ozzohelmets.cloud`, so
    `PUBLIC_EMERGENCY_BASE_URL=https://ozzohelmets.cloud` (this is printed into every QR
    label, so it is final);
  - admin = `admin.ozzohelmets.cloud` (its DNS record still needs to be added in Cloudflare);
  - api = `api.ozzohelmets.cloud`.

### Server details

The server address, the services already running on it, and the existing database credentials
are deliberately **not** in this public repository. Get them from me in chat or from the private
copy of this prompt. Run a read-only inspection before proposing anything. Note that the server
already runs a hosting panel (aaPanel) whose nginx owns ports 80/443, other apps that must not be
disrupted, and PostgreSQL bound to localhost.

### Deployment approach to propose (then confirm with me)

1. Run a second read-only inspection first:
   - aaPanel Postgres binary path, version, `listen_addresses`, `hba_file`;
   - whether database `ozzo` exists and holds data;
   - aaPanel nginx vhosts in `/www/server/panel/vhost/nginx/` (server_name, proxy_pass);
   - which existing apps run on the server and on which ports.
2. Install Docker Engine + the Compose plugin (official apt repository).
3. **Do not run the repo's edge container on 80/443.** aaPanel's nginx stays the public edge.
   - Add three aaPanel sites (`ozzohelmets.cloud`, `admin.`, `api.`) with TLS: a Cloudflare
     Origin CA certificate, SSL mode Full (strict).
   - They reverse-proxy to the Helmet stack published **only on 127.0.0.1**.
   - Either run the repo edge container on a loopback port, or proxy straight to the
     portal/admin containers.
   - Port the important edge behaviour into that setup:
     - Cloudflare real IP from Cloudflare ranges only;
     - overwrite `X-Forwarded-For`; strip `CF-Connecting-IP` before the app;
     - API `TRUST_PROXY` set to the right subnet;
     - HSTS and CSP;
     - `/api/v1/internal/` returns 404;
     - rate limits;
     - access logs without IPs.
   - Prefer a small compose override file (for example `deploy/compose/aapanel.yml`) plus docs
     over changing the base compose file.
4. **Database: ask me to choose.**
   - Option A (recommended): the bundled Postgres container from `docker-compose.prod.yml`, with
     db/user `ozzo` and a strong generated password. It is isolated, and backup/restore are
     already tested against it.
   - Option B: the existing aaPanel host Postgres. It would need:
     - `listen_addresses` and `pg_hba` changes for the Docker bridge (aaPanel may overwrite
       them);
     - a compose override (no postgres service; api/worker reach the host via host-gateway);
     - backup/restore using a host-side pg_dump or a client container;
     - `restore-drill.sh` must stay isolated and **never** touch the production DB.
5. Create `/etc/helmet-platform/{app,compose,postgres,backup}.env` from `deploy/env/*.example`
   with generated secrets.
6. `scripts/deploy-vps.sh`, then `admin:bootstrap` (password via stdin), then enable
   `helmet-backup.timer`.
7. Smoke-test through Cloudflare: `/e/<token>`, `/verify`, login, admin dashboard, CSP, metrics
   returns 404.
8. Report what remains from `docs/LAUNCH-CHECKLIST.md`.

### Security follow-ups to remind me of

- Change any root password or SSH key that was shared in chat.
- Switch to key-only SSH (only after I confirm I have working key access).
- If plain FTP is open on the server, suggest SFTP instead.
