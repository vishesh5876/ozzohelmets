import type { AdminRole } from '@helmet/types';
import { AnalyticsAggregationService } from '../src/modules/analytics/analytics-aggregation.service';
import {
  bearer,
  createAdmin,
  createTestApp,
  createTestHelmet,
  login,
  registerCustomer,
  resetState,
  type TestContext,
} from './utils';

/**
 * Phase 8: operator-facing state derived from existing data (no new tables):
 * Activation PIN state, batch export history and counts, batch filters, one-box helmet search
 * (customer lookups only with customers:read), and internal test models excluded from analytics.
 */
describe('Phase 8 — operational clarity (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
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
  const pinState = async (token: string, helmetId: string) =>
    (await ctx.http().get(`/api/v1/admin/helmets/${helmetId}`).set(bearer(token)).expect(200)).body
      .data.pinState as string;

  it('Activation PIN state: available → exported → purged, and consumed after activation', async () => {
    const admin = await asAdmin('ADMIN');
    const h = await createTestHelmet(ctx, 'GENERATED');
    expect(await pinState(admin.token, h.id)).toBe('AVAILABLE');

    await ctx
      .http()
      .get(`/api/v1/admin/batches/${h.batchId}/export/manufacturing.csv`)
      .set(bearer(admin.token))
      .expect(200);
    const detail = await ctx.http().get(`/api/v1/admin/helmets/${h.id}`).set(bearer(admin.token));
    expect(detail.body.data.pinState).toBe('EXPORTED');
    expect(detail.body.data.batchLastExportedAt).toEqual(expect.any(String));
    // The detail never carries the PIN itself.
    expect(JSON.stringify(detail.body)).not.toContain(h.pin);

    await ctx
      .http()
      .post(`/api/v1/admin/batches/${h.batchId}/mark-printed`)
      .set(bearer(admin.token))
      .expect(200);
    expect(await pinState(admin.token, h.id)).toBe('PURGED');

    const sold = await createTestHelmet(ctx, 'SOLD');
    await registerCustomer(ctx, sold);
    expect(await pinState(admin.token, sold.id)).toBe('CONSUMED');
  });

  it('batch detail: export history and per-status counts; list filters by print status and date', async () => {
    const admin = await asAdmin('ADMIN');
    const h = await createTestHelmet(ctx, 'GENERATED');
    const before = await ctx
      .http()
      .get(`/api/v1/admin/batches/${h.batchId}`)
      .set(bearer(admin.token))
      .expect(200);
    expect(before.body.data).toMatchObject({ exportCount: 0, lastExportedAt: null });
    expect(before.body.data.stats).toEqual({
      generated: 1,
      printed: 0,
      activated: 0,
      active: 0,
      lostOrStolen: 0,
      remaining: 1,
    });

    for (let i = 0; i < 2; i++)
      await ctx
        .http()
        .get(`/api/v1/admin/batches/${h.batchId}/export/manufacturing.csv`)
        .set(bearer(admin.token))
        .expect(200);
    await ctx
      .http()
      .post(`/api/v1/admin/batches/${h.batchId}/mark-printed`)
      .set(bearer(admin.token))
      .expect(200);
    const after = await ctx
      .http()
      .get(`/api/v1/admin/batches/${h.batchId}`)
      .set(bearer(admin.token))
      .expect(200);
    expect(after.body.data.exportCount).toBe(2);
    expect(after.body.data.stats).toMatchObject({ generated: 1, printed: 1, remaining: 1 });

    const list = (q: Record<string, string>) =>
      ctx.http().get('/api/v1/admin/batches').query(q).set(bearer(admin.token)).expect(200);
    const printed = await list({ printStatus: 'PRINTED' });
    expect(printed.body.data.map((b: { id: string }) => b.id)).toContain(h.batchId);
    expect(printed.body.data[0]).toHaveProperty('exportCount');
    const notPrinted = await list({ printStatus: 'NOT_PRINTED' });
    expect(notPrinted.body.data.map((b: { id: string }) => b.id)).not.toContain(h.batchId);
    // Test batches are manufactured 2026-01-01.
    expect(
      (await list({ manufacturedFrom: '2026-01-01', manufacturedTo: '2026-01-01' })).body.data
        .length,
    ).toBeGreaterThan(0);
    expect((await list({ manufacturedFrom: '2026-01-02' })).body.data).toHaveLength(0);
    expect((await list({ search: 'Roadster' })).body.data.length).toBeGreaterThan(0);
    await ctx
      .http()
      .get('/api/v1/admin/batches')
      .query({ manufacturedFrom: 'not-a-date' })
      .set(bearer(admin.token))
      .expect(400);
  });

  it('helmet search: batch code, model, and owner email / Customer ID only with customers:read', async () => {
    const support = await asAdmin('SUPPORT');
    const manufacturing = await asAdmin('MANUFACTURING');
    const h = await createTestHelmet(ctx, 'SOLD');
    const customer = await registerCustomer(ctx, h);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    const batch = await ctx.prisma.helmetBatch.findUniqueOrThrow({ where: { id: h.batchId } });

    const search = (token: string, term: string) =>
      ctx
        .http()
        .get('/api/v1/admin/helmets')
        .query({ search: term })
        .set(bearer(token))
        .expect(200)
        .then((r) => r.body.data.map((x: { id: string }) => x.id) as string[]);

    expect(await search(support.token, customer.email.toUpperCase())).toEqual([h.id]);
    expect(await search(support.token, user.customerCode)).toEqual([h.id]);
    expect(await search(support.token, 'roadster')).toContain(h.id);
    // Batch codes from the test helper (BAT-T-…) match as fragments; real codes (BAT-YYYY-NNNNN) exactly.
    expect(await search(support.token, batch.batchCode)).toContain(h.id);
    // Without customers:read, customer identifiers match nothing (no email → helmet probing).
    expect(await search(manufacturing.token, customer.email)).toEqual([]);
    expect(await search(manufacturing.token, user.customerCode)).toEqual([]);
    expect(await search(manufacturing.token, h.helmetCode)).toEqual([h.id]);
  });

  it('internal test model (OZZO-INTERNAL-TEST) is excluded from platform analytics', async () => {
    const admin = await asAdmin('ADMIN');
    const real = await createTestHelmet(ctx, 'SOLD');
    await registerCustomer(ctx, real);
    const testModel = await ctx.prisma.helmetModel.create({
      data: { name: 'OZZO INTERNAL TEST', sku: 'OZZO-INTERNAL-TEST', brand: 'Ozzo' },
    });
    const fixture = await createTestHelmet(ctx, 'SOLD', 'WXYZ2345');
    await ctx.prisma.helmet.update({
      where: { id: fixture.id },
      data: { helmetModelId: testModel.id },
    });
    await registerCustomer(ctx, fixture);

    const overview = await ctx
      .http()
      .get('/api/v1/admin/analytics/overview')
      .query({ range: '7d' })
      .set(bearer(admin.token))
      .expect(200);
    const totals = JSON.stringify(overview.body.data);
    // Two helmets exist and both are activated, but only the real one counts.
    expect(await ctx.prisma.helmet.count()).toBe(2);
    expect(overview.body.data.current).toMatchObject({ helmetsGenerated: 1, helmetsActivated: 1 });
    expect(totals).not.toContain('OZZO-INTERNAL-TEST');

    const today = new Date().toISOString().slice(0, 10);
    await ctx.app.get(AnalyticsAggregationService).aggregatePlatformDay(today, true);
    const day = await ctx.prisma.platformDailyStats.findUniqueOrThrow({
      where: { date: new Date(today) },
    });
    expect(day.helmetsGenerated).toBe(1);
    expect(day.helmetsActivated).toBe(1);
  });
});
