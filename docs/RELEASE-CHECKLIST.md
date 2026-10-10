# Release checklist

Use for every production release, starting with **v1.0.0**. Production runs the PM2 / aaPanel
layout ([PM2-DEPLOYMENT](PM2-DEPLOYMENT.md)). Record each release in
[CHANGELOG](../CHANGELOG.md) and in the ops log.

## 1. Before tagging

- [ ] **CI green** on the release commit: quality, integration (fresh migrate + drift + e2e),
      Playwright, Docker builds and config validation.
- [ ] Locally or in CI: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`,
      `pnpm --filter @helmet/api test:e2e` (run in band), Playwright suite, `pnpm build`.
- [ ] `pnpm audit --prod`: no new critical or high findings in runtime dependencies.
- [ ] Migrations in this release are additive and backward compatible for one release.
      `prisma migrate diff` shows no drift.
- [ ] [CHANGELOG](../CHANGELOG.md) updated: version, date, capabilities and fixes (not a commit
      dump), migration list.

## 2. Tag

```bash
git checkout claude/epic-gates-7picyo && git pull --ff-only
git tag -a v1.0.0 -m "v1.0.0: <one line>"      # annotated; the deploy shows this as the version
git push origin v1.0.0
```

The deploy script reports `git describe --tags` as `APP_VERSION`, so the admin footer and
`helmet_build_info` show the tag.

## 3. Deploy (on the VPS)

- [ ] **Backup succeeded today** (or run one now):
      `sudo -u ozzo /opt/ozzohelmets/scripts/pg-backup.sh`, then check the newest set's
      checksums (step 5 report).
- [ ] Disk has headroom (> 20 % free); no open SEV1/SEV2 incident.
- [ ] `sudo -iu ozzo /opt/ozzohelmets/scripts/pm2-deploy.sh`
      (backup → build → `migrate deploy` → SPA symlink swap → `pm2 startOrReload` → health wait).
- [ ] Record: git SHA, tag, release date, latest migration name, deployed `APP_VERSION`.

## 4. Verify

- [ ] **Smoke test** from anywhere:
      `TEST_TOKEN=<internal test helmet token> scripts/production-smoke.sh` gives `SMOKE OK`.
- [ ] **Server health report**:
      `sudo /opt/ozzohelmets/scripts/ozzo-health-report.sh`. Check:
  - migrations current, none failed;
  - **worker healthy**: heartbeat < 1 min, every job succeeded within its interval, no failures
    accumulating;
  - **backup** timer active, latest set has valid checksums and is < 26 h old;
  - **disk** healthy;
  - Postgres connections normal, no lock waits;
  - Redis has no evictions and no rejected connections;
  - no burst of 5xx or error log lines since the deploy.
- [ ] Admin → Dashboard → System status: worker alive, jobs green, footer shows the new version.
- [ ] **Monitoring healthy**: the external uptime checks are green. After a major release, prove
      once that an alert reaches its destination (pause the test helmet's sharing for 3 minutes,
      or point a check at a 404 URL).
- [ ] **Real-device QR test**: scan the internal test helmet's printed label with an iPhone and an
      Android phone on mobile data. The emergency page shows the synthetic profile, call buttons
      dial, and verify shows the right model.
- [ ] Browser devtools on the portal, admin and `/e/<token>`: no CSP violations, no console
      errors.

## 5. People

- [ ] **Support ready**: release notes read; any changed wording or flows shown to the team
      ([support SOP](runbooks/support.md)).
- [ ] **Manufacturing ready**: if batch or label flows changed, the
      [manufacturing runbook](runbooks/manufacturing.md) is updated and walked through.

## Rollback

Code only (migrations stay; they are forward-compatible):
`sudo -iu ozzo bash -c 'cd /opt/ozzohelmets && git checkout <previous tag> && scripts/pm2-deploy.sh --no-pull'`.
Then repeat step 4. Data problems are handled with
[DISASTER-RECOVERY](DISASTER-RECOVERY.md) and [PM2-DEPLOYMENT → Restore](PM2-DEPLOYMENT.md#restore),
never with `migrate reset`.
