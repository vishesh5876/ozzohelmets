import { createHash } from 'node:crypto';
import type { AdminRole } from '@helmet/types';
import { AnalyticsAggregationService } from '../src/modules/analytics/analytics-aggregation.service';
import { JobRunnerService } from '../src/modules/analytics/job-runner.service';
import { RetentionService } from '../src/modules/analytics/retention.service';
import { RiskEvaluationService } from '../src/modules/analytics/risk-evaluation.service';
import {
  bearer,
  completeProfile,
  createAdmin,
  createTestApp,
  createTestHelmet,
  enableOnHelmet,
  login,
  newCustomer,
  publicView,
  resetState,
  type TestContext,
  waitFor,
} from './utils';

/**
 * Phase 6: aggregation, deterministic risk signals, alerts, source-level detection (enumeration,
 * scraping), QR integrity, customer summary, retention, job locking, RBAC and privacy.
 * Thresholds come from test/test-env.ts (RISK_HIGH_SCAN_HOURLY=20, RISK_UNIQUE_IP_HOURLY=8,
 * RISK_IP_CHURN_15MIN=6, RISK_VERIFY_DAILY=10, RISK_MIN_SCANS_FOR_EVALUATION=5,
 * ENUMERATION_INVALID_TOKEN_LIMIT=5, VALID_TOKEN_SCRAPE_LIMIT=4).
 */
const ipHash = (n: number | string) => createHash('sha256').update(`test-ip-${n}`).digest('hex');

describe('Phase 6 — analytics & QR abuse detection (e2e)', () => {
  let ctx: TestContext;
  let aggregation: AnalyticsAggregationService;
  let risk: RiskEvaluationService;
  let retention: RetentionService;
  let runner: JobRunnerService;

  beforeAll(async () => {
    ctx = await createTestApp();
    aggregation = ctx.app.get(AnalyticsAggregationService);
    risk = ctx.app.get(RiskEvaluationService);
    retention = ctx.app.get(RetentionService);
    runner = ctx.app.get(JobRunnerService);
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetState(ctx);
  });

  const asAdmin = async (role: AdminRole) => {
    const a = await createAdmin(ctx, role, `${role.toLowerCase()}.${Date.now()}@test.local`);
    const { token } = await login(ctx, a.email, a.password);
    return { ...a, token };
  };

  /** Inserts scans directly (no HTTP dedup) so scenarios are exact and deterministic. */
  const insertScans = (
    helmetId: string,
    n: number,
    opts: {
      at?: (i: number) => Date;
      ip?: (i: number) => string;
      type?: 'EMERGENCY_PAGE' | 'VERIFY';
      device?: 'MOBILE' | 'BOT';
      synthetic?: boolean;
    } = {},
  ) =>
    ctx.prisma.helmetScan.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        helmetId,
        scanType: opts.type ?? 'EMERGENCY_PAGE',
        scannedAt: opts.at?.(i) ?? new Date(Date.now() - (i % 50) * 1000),
        ipHash: opts.ip?.(i) ?? ipHash(1),
        userAgent: 'Mobile Safari on iOS',
        deviceCategory: opts.device ?? 'MOBILE',
        synthetic: opts.synthetic ?? false,
      })),
    });

  describe('aggregation', () => {
    it('builds idempotent daily aggregates that exclude bots and synthetic rows', async () => {
      const h = await createTestHelmet(ctx, 'SOLD');
      await insertScans(h.id, 6, { ip: (i) => ipHash(i % 3) });
      await insertScans(h.id, 3, { type: 'VERIFY' });
      await insertScans(h.id, 4, { device: 'BOT' });
      await insertScans(h.id, 7, { synthetic: true });
      await aggregation.aggregateRecent();
      await aggregation.aggregateRecent(); // re-run converges to the same rows
      const rows = await ctx.prisma.helmetScanDaily.findMany({ where: { helmetId: h.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        totalScans: 9,
        emergencyScans: 6,
        verificationScans: 3,
        botScans: 4,
        uniqueIpHashes: 3,
      });
      // Today and yesterday are (re)computed; yesterday simply has no scans.
      const days = await ctx.prisma.platformDailyStats.findMany({ orderBy: { date: 'desc' } });
      expect(days).toHaveLength(2);
      expect(days[1]).toMatchObject({ emergencyScans: 0, verificationScans: 0 });
      expect(days[0]).toMatchObject({ emergencyScans: 6, verificationScans: 3, uniqueHelmetsScanned: 1 });
    });

    it('serves scan analytics and overview from aggregates + today', async () => {
      const h = await createTestHelmet(ctx, 'SOLD');
      const yesterday = new Date(Date.now() - 24 * 3600_000);
      await insertScans(h.id, 5, { at: () => yesterday });
      await insertScans(h.id, 2);
      await aggregation.aggregateRecent();
      const viewer = await asAdmin('ANALYTICS_VIEWER');
      const scans = await ctx
        .http()
        .get('/api/v1/admin/analytics/scans?range=7d')
        .set(bearer(viewer.token))
        .expect(200);
      expect(scans.body.data.today.total).toBe(2);
      expect(scans.body.data.last7d.total).toBe(7);
      expect(scans.body.data.topHelmets[0]).toMatchObject({ helmetCode: h.helmetCode, scans: 7 });
      const overview = await ctx
        .http()
        .get('/api/v1/admin/analytics/overview?range=30d')
        .set(bearer(viewer.token))
        .expect(200);
      expect(overview.body.data.series).toHaveLength(30);
      expect(overview.body.data.period.emergencyScans).toBe(7);
      expect(JSON.stringify(overview.body)).not.toMatch(/allerg|blood|medic|contact.*phone/i);
    });
  });

  describe('risk evaluation', () => {
    it('a normally used helmet gets no signals, assessment or alert', async () => {
      const h = await createTestHelmet(ctx, 'SOLD');
      await insertScans(h.id, 6, { ip: (i) => ipHash(i % 2) });
      const r = await risk.evaluate();
      expect(r.signalsUpserted).toBe(0);
      expect(await ctx.prisma.helmetRiskSignal.count()).toBe(0);
      expect(await ctx.prisma.riskAlert.count()).toBe(0);
    });

    it('high volume alone → LOW/MEDIUM signal and one deduplicated alert across repeated runs', async () => {
      const h = await createTestHelmet(ctx, 'SOLD');
      await insertScans(h.id, 25); // > 20/h from one source
      await risk.evaluate();
      await risk.evaluate();
      await risk.evaluate();
      const a = await ctx.prisma.helmetRiskAssessment.findUniqueOrThrow({ where: { helmetId: h.id } });
      expect(['LOW', 'MEDIUM']).toContain(a.riskLevel);
      const alerts = await ctx.prisma.riskAlert.findMany();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ type: 'HIGH_PUBLIC_SCAN_VOLUME', occurrences: 3 });
      expect(alerts[0]!.summary).toContain('Review recommended');
      expect(alerts[0]!.summary).not.toMatch(/counterfeit|fake|fraud/i);
      expect(await ctx.prisma.helmetRiskSignal.count({ where: { status: 'ACTIVE' } })).toBe(1);
      // Lifecycle status is never changed by analytics.
      expect((await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: h.id } })).status).toBe('SOLD');
    });

    it('false-positive safety: crash scene with many scans from few phones stays below HIGH', async () => {
      const h = await createTestHelmet(ctx, 'SOLD');
      await insertScans(h.id, 60, { ip: (i) => ipHash(i % 4) });
      await risk.evaluate();
      const a = await ctx.prisma.helmetRiskAssessment.findUniqueOrThrow({ where: { helmetId: h.id } });
      expect(['LOW', 'MEDIUM']).toContain(a.riskLevel);
    });

    it('many distinct visitors + unusual verification → possible copied QR, HIGH or above, explained', async () => {
      const h = await createTestHelmet(ctx, 'SOLD');
      await insertScans(h.id, 30, { ip: (i) => ipHash(`v${i}`), at: (i) => new Date(Date.now() - i * 20_000) });
      await insertScans(h.id, 15, { type: 'VERIFY', ip: (i) => ipHash(`w${i}`) });
      await risk.evaluate();
      const a = await ctx.prisma.helmetRiskAssessment.findUniqueOrThrow({ where: { helmetId: h.id } });
      expect(['HIGH', 'CRITICAL']).toContain(a.riskLevel);
      const reasons = a.reasons as { type: string; observed: number; threshold: number; detail: string }[];
      expect(reasons.map((r) => r.type)).toEqual(
        expect.arrayContaining(['HIGH_UNIQUE_VISITOR_COUNT', 'ABNORMAL_VERIFY_ACTIVITY', 'QR_SHARED_OR_COPIED_POSSIBLE']),
      );
      for (const r of reasons) expect(r.detail.length).toBeGreaterThan(0);
      const alert = await ctx.prisma.riskAlert.findFirstOrThrow({ where: { helmetId: h.id } });
      expect(alert.type).toBe('HELMET_SCAN_ANOMALY');
      // Signal metadata holds counts only — never IP hashes.
      const signals = await ctx.prisma.helmetRiskSignal.findMany({ where: { helmetId: h.id } });
      expect(JSON.stringify(signals)).not.toContain(ipHash('v1'));
    });

    it('stale signals clear and the assessment drops back to NONE', async () => {
      const h = await createTestHelmet(ctx, 'SOLD');
      await insertScans(h.id, 25);
      await risk.evaluate();
      await ctx.prisma.helmetScan.deleteMany({});
      await risk.evaluate(new Date(Date.now() + 25 * 3600_000));
      expect(await ctx.prisma.helmetRiskSignal.count({ where: { status: 'ACTIVE' } })).toBe(0);
      const a = await ctx.prisma.helmetRiskAssessment.findUniqueOrThrow({ where: { helmetId: h.id } });
      expect(a).toMatchObject({ riskLevel: 'NONE', riskScore: 0 });
    });
  });

  describe('public availability under risk', () => {
    it('emergency page keeps working for HIGH-risk and COMPROMISED helmets; verify shows a neutral notice', async () => {
      const c = await newCustomer(ctx);
      await completeProfile(ctx, c.token, 'Still Reachable');
      await enableOnHelmet(ctx, c.token, c.helmet.id);
      await insertScans(c.helmet.id, 30, { ip: (i) => ipHash(`p${i}`) });
      await insertScans(c.helmet.id, 15, { type: 'VERIFY', ip: (i) => ipHash(`q${i}`) });
      await risk.evaluate();
      const admin = await asAdmin('ADMIN');
      await ctx
        .http()
        .patch(`/api/v1/admin/analytics/helmets/${c.helmet.helmetCode}/qr-integrity`)
        .set(bearer(admin.token))
        .send({ status: 'COMPROMISED', note: 'Owner reported a copied sticker' })
        .expect(200);
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view.profile?.name).toBe('Still Reachable');
      expect(JSON.stringify(view)).not.toMatch(/risk|compromis|suspicious/i);
      const verify = await ctx.http().get(`/api/v1/public/verify/${c.helmet.publicToken}`).expect(200);
      expect(verify.body.data.state).toBe('VERIFIED');
      expect(verify.body.data.integrityNotice).toMatch(/possibly copied/);
      expect(verify.body.data.integrityNotice).not.toMatch(/counterfeit|fake|fraud/i);
      const helmet = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: c.helmet.id } });
      expect(helmet.status).toBe('ACTIVE');
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'helmet.qr_integrity.changed', entityId: c.helmet.id } }),
      ).toBe(1);
      // Back to NORMAL removes the notice (cache invalidated).
      await ctx
        .http()
        .patch(`/api/v1/admin/analytics/helmets/${c.helmet.helmetCode}/qr-integrity`)
        .set(bearer(admin.token))
        .send({ status: 'NORMAL', note: 'Checked with the owner' })
        .expect(200);
      const again = await ctx.http().get(`/api/v1/public/verify/${c.helmet.publicToken}`).expect(200);
      expect(again.body.data.integrityNotice).toBeUndefined();
    });
  });

  describe('source-level detection', () => {
    it('token enumeration raises one TOKEN_ENUMERATION alert with counts only', async () => {
      const unknown = (i: number) => `${'B'.repeat(20)}${String(i).padStart(2, '0')}`;
      for (let i = 0; i < 8; i++) await ctx.http().get(`/api/v1/public/emergency/${unknown(i)}`);
      const alerts = await waitFor(
        () => ctx.prisma.riskAlert.findMany({ where: { type: 'TOKEN_ENUMERATION' } }),
        (a) => a.length > 0,
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.sourceRef).toMatch(/^[0-9a-f]{12}$/);
      const raw = JSON.stringify(alerts);
      expect(raw).not.toContain(unknown(1));
      expect(raw).not.toContain('127.0.0.1');
      // Unknown tokens are never stored anywhere.
      expect(await ctx.prisma.helmetScan.count()).toBe(0);
    });

    it('valid-token scraping raises an alert and rations uncached lookups, emergency pages for cached helmets stay up', async () => {
      const c = await newCustomer(ctx);
      await completeProfile(ctx, c.token, 'Cached Rider');
      await enableOnHelmet(ctx, c.token, c.helmet.id);
      await publicView(ctx, c.helmet.publicToken); // genuinely scanned → cached
      const helmets = await Promise.all(Array.from({ length: 9 }, () => createTestHelmet(ctx, 'SOLD')));
      const statuses: number[] = [];
      for (const h of helmets)
        statuses.push((await ctx.http().get(`/api/v1/public/emergency/${h.publicToken}`)).status);
      const alert = await waitFor(
        () => ctx.prisma.riskAlert.findFirst({ where: { type: 'VALID_TOKEN_SCRAPING' } }),
        (a) => a !== null,
      );
      expect(alert!.summary).not.toMatch(/counterfeit|fake|fraud/i);
      expect(statuses.slice(0, 4).every((s) => s === 200)).toBe(true);
      expect(statuses).toContain(429);
      expect((await publicView(ctx, c.helmet.publicToken)).profile?.name).toBe('Cached Rider');
    });
  });

  describe('alert workflow, RBAC and privacy', () => {
    const setupAlert = async () => {
      const h = await createTestHelmet(ctx, 'SOLD');
      await insertScans(h.id, 25);
      await risk.evaluate();
      const alert = await ctx.prisma.riskAlert.findFirstOrThrow();
      return { h, alert };
    };

    it('support acknowledges, assigns and resolves (reason required, audited); resolved alert is not recreated', async () => {
      const { h, alert } = await setupAlert();
      const support = await asAdmin('SUPPORT');
      const patch = (body: object) =>
        ctx.http().patch(`/api/v1/admin/risk-alerts/${alert.id}`).set(bearer(support.token)).send(body);
      expect((await patch({ status: 'ACKNOWLEDGED' })).status).toBe(200);
      expect((await patch({ assignedAdminId: support.id })).body.data.assignee.id).toBe(support.id);
      expect((await patch({ status: 'RESOLVED' })).status).toBe(400);
      const resolved = await patch({ status: 'RESOLVED', resolutionReason: 'Owner shared QR at a group ride' });
      expect(resolved.status).toBe(200);
      expect(resolved.body.data.status).toBe('RESOLVED');
      expect((await patch({ status: 'OPEN' })).status).toBe(409);
      expect(
        await ctx.prisma.auditLog.count({
          where: { action: { startsWith: 'risk_alert.' }, entityId: alert.id },
        }),
      ).toBe(3);
      await insertScans(h.id, 5);
      await risk.evaluate();
      expect(await ctx.prisma.riskAlert.count()).toBe(1);
      const list = await ctx
        .http()
        .get('/api/v1/admin/risk-alerts?status=OPEN_ANY')
        .set(bearer(support.token))
        .expect(200);
      expect(list.body.data.items).toHaveLength(0);
    });

    it('cursor-paginates alerts', async () => {
      const support = await asAdmin('SUPPORT');
      for (let i = 0; i < 5; i++) {
        const h = await createTestHelmet(ctx, 'SOLD');
        await insertScans(h.id, 25);
      }
      await risk.evaluate();
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const res = await ctx
          .http()
          .get('/api/v1/admin/risk-alerts')
          .query({ limit: 2, ...(cursor ? { cursor } : {}) })
          .set(bearer(support.token))
          .expect(200);
        seen.push(...res.body.data.items.map((a: { id: string }) => a.id));
        cursor = res.body.data.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('ANALYTICS_VIEWER reads aggregates only; MANUFACTURING has no analytics; no IP hashes in responses', async () => {
      const { h, alert } = await setupAlert();
      const viewer = await asAdmin('ANALYTICS_VIEWER');
      const mfg = await asAdmin('MANUFACTURING');
      const detail = await ctx
        .http()
        .get(`/api/v1/admin/analytics/helmets/${h.helmetCode}`)
        .set(bearer(viewer.token))
        .expect(200);
      expect(detail.body.data.alerts).toBeUndefined();
      expect(detail.body.data.signals.length).toBeGreaterThan(0);
      const events = await ctx
        .http()
        .get(`/api/v1/admin/analytics/helmets/${h.helmetCode}/scans?limit=5`)
        .set(bearer(viewer.token))
        .expect(200);
      expect(events.body.data.items).toHaveLength(5);
      expect(events.body.data.nextCursor).toBeTruthy();
      for (const body of [detail.body, events.body]) {
        const raw = JSON.stringify(body);
        expect(raw).not.toContain(ipHash(1));
        expect(raw).not.toMatch(/ipHash|ip_hash|userAgent/);
      }
      await ctx.http().get('/api/v1/admin/risk-alerts').set(bearer(viewer.token)).expect(403);
      await ctx
        .http()
        .patch(`/api/v1/admin/risk-alerts/${alert.id}`)
        .set(bearer(viewer.token))
        .send({ status: 'ACKNOWLEDGED' })
        .expect(403);
      await ctx
        .http()
        .patch(`/api/v1/admin/analytics/helmets/${h.helmetCode}/qr-integrity`)
        .set(bearer(viewer.token))
        .send({ status: 'UNDER_REVIEW', note: 'not allowed' })
        .expect(403);
      await ctx.http().get('/api/v1/admin/analytics/overview').set(bearer(mfg.token)).expect(403);
      const support = await asAdmin('SUPPORT');
      await ctx
        .http()
        .patch(`/api/v1/admin/analytics/helmets/${h.helmetCode}/qr-integrity`)
        .set(bearer(support.token))
        .send({ status: 'UNDER_REVIEW', note: 'support cannot' })
        .expect(403);
      // Raw IPs are never persisted.
      const ips = await ctx.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM helmet_scans WHERE ip_hash LIKE '%127.0.0.1%' OR ip_hash LIKE '%::1%'`;
      expect(Number(ips[0]!.n)).toBe(0);
    });
  });

  describe('customer scan summary', () => {
    it('shows neutral counts to the owner only, since their ownership began', async () => {
      const c = await newCustomer(ctx);
      const other = await newCustomer(ctx);
      // Scans before this owner's activation (e.g. at the factory or a previous owner) don't count.
      await insertScans(c.helmet.id, 3, { at: () => new Date(Date.now() - 3600_000) });
      const after = () => new Date(Date.now() + 1000);
      await insertScans(c.helmet.id, 2, { at: after });
      await insertScans(c.helmet.id, 1, { type: 'VERIFY', at: after });
      await insertScans(c.helmet.id, 4, { device: 'BOT', at: after });
      await insertScans(c.helmet.id, 5, { at: () => new Date(Date.now() - 40 * 24 * 3600_000) });
      const res = await ctx
        .http()
        .get(`/api/v1/customer/helmets/${c.helmet.id}/scan-summary`)
        .set(bearer(c.token))
        .expect(200);
      expect(res.body.data.message).toBe('Your helmet QR was accessed 3 times in the last 30 days.');
      expect(Object.keys(res.body.data).sort()).toEqual(
        ['emergencyScans30d', 'lastEmergencyScanAt', 'message', 'since', 'verificationScans30d'].sort(),
      );
      await ctx
        .http()
        .get(`/api/v1/customer/helmets/${c.helmet.id}/scan-summary`)
        .set(bearer(other.token))
        .expect(404);
    });
  });

  describe('retention & jobs', () => {
    it('deletes old detailed scans after aggregation, keeping aggregates, ownership, warranty and audit history', async () => {
      const c = await newCustomer(ctx);
      const now = new Date('2026-10-04T12:00:00Z');
      const old = new Date('2026-03-01T10:00:00Z'); // > 180 days before `now`
      await insertScans(c.helmet.id, 6, { at: () => old });
      await insertScans(c.helmet.id, 2, { at: () => new Date('2026-10-03T10:00:00Z') });
      await aggregation.aggregateDay('2026-03-01', '2026-10-04');
      const auditBefore = await ctx.prisma.auditLog.count();
      const ownershipBefore = await ctx.prisma.helmetOwnership.count();
      const result = await retention.run(now);
      expect(result.scansDeleted).toBe(6);
      expect(await ctx.prisma.helmetScan.count()).toBe(2);
      const agg = await ctx.prisma.helmetScanDaily.findFirstOrThrow({ where: { helmetId: c.helmet.id } });
      expect(agg.totalScans).toBe(6);
      // Re-aggregating a purged day never zeroes it.
      await aggregation.aggregateDay('2026-03-01', '2026-10-04');
      expect((await ctx.prisma.helmetScanDaily.findFirstOrThrow({ where: { id: agg.id } })).totalScans).toBe(6);
      expect(await ctx.prisma.auditLog.count()).toBe(auditBefore);
      expect(await ctx.prisma.helmetOwnership.count()).toBe(ownershipBefore);
      expect(await ctx.prisma.helmet.count({ where: { id: c.helmet.id } })).toBe(1);
    });

    it('advisory lock: a concurrent run of the same job is SKIPPED, runs are recorded', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const first = runner.run('analytics.aggregate', () => gate.then(() => ({ ok: true })));
      await new Promise((r) => setTimeout(r, 200));
      const second = await runner.run('analytics.aggregate', async () => ({ ok: true }));
      expect(second.status).toBe('SKIPPED');
      const other = await runner.run('retention.cleanup', async () => ({ ok: true }));
      expect(other.status).toBe('SUCCEEDED');
      release();
      expect((await first).status).toBe('SUCCEEDED');
      const failed = await runner.run('risk.evaluate', () => Promise.reject(new Error('boom')));
      expect(failed.status).toBe('FAILED');
      const runs = await ctx.prisma.workerJobRun.findMany({ orderBy: { startedAt: 'asc' } });
      expect(runs.map((r) => `${r.job}:${r.status}`).sort()).toEqual(
        ['analytics.aggregate:SUCCEEDED', 'retention.cleanup:SUCCEEDED', 'risk.evaluate:FAILED'].sort(),
      );
    });
  });
});
