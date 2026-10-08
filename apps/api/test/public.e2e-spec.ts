import { createAdmin, createTestApp, login, resetState, type TestContext, waitFor } from './utils';

describe('Public emergency endpoint (e2e)', () => {
  let ctx: TestContext;
  let token: string;
  let helmetId: string;
  let auth: { Authorization: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetState(ctx);
    const admin = await createAdmin(ctx, 'ADMIN');
    auth = { Authorization: `Bearer ${(await login(ctx, admin.email, admin.password)).token}` };
    const model = await ctx
      .http()
      .post('/api/v1/admin/helmet-models')
      .set(auth)
      .send({ name: 'Urban Jet', sku: 'UJ-1', brand: 'Ozzo' })
      .expect(201);
    const batch = await ctx
      .http()
      .post('/api/v1/admin/batches')
      .set(auth)
      .send({ helmetModelId: model.body.data.id, manufacturingDate: '2026-09-01', quantity: 3 })
      .expect(201);
    await ctx
      .http()
      .post(`/api/v1/admin/batches/${batch.body.data.id}/generate`)
      .set(auth)
      .expect(202);
    await waitFor(
      () => ctx.prisma.helmetBatch.findUniqueOrThrow({ where: { id: batch.body.data.id } }),
      (b) => b.generationStatus === 'COMPLETED',
    );
    const helmet = await ctx.prisma.helmet.findFirstOrThrow();
    token = helmet.publicToken;
    helmetId = helmet.id;
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('resolves an unactivated helmet without authentication and leaks nothing internal', async () => {
    const res = await ctx.http().get(`/api/v1/public/emergency/${token}`).expect(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        state: 'NOT_ACTIVATED',
        helmet: { modelName: 'Urban Jet', brand: 'Ozzo' },
        message: 'This helmet has not yet been activated.',
      },
    });
    const raw = JSON.stringify(res.body);
    const helmet = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: helmetId } });
    for (const secret of [
      helmet.id,
      helmet.helmetCode,
      helmet.serialNumber,
      helmet.activationPinHash,
      helmet.batchId,
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
  });

  it('logs scans with hashed IPs only', async () => {
    await ctx
      .http()
      .get(`/api/v1/public/emergency/${token}`)
      .set('User-Agent', 'EmergencyTest/1.0')
      .expect(200);
    const scan = await waitFor(
      () => ctx.prisma.helmetScan.findFirst({
          where: { helmetId, scanType: 'EMERGENCY_PAGE', deviceCategory: { not: null } },
        }),
      (s) => s !== null,
    );
    expect(scan!.scanType).toBe('EMERGENCY_PAGE');
    // Only a coarse summary and device class are kept, never the raw User-Agent string.
    expect(scan!.userAgent).not.toBe('EmergencyTest/1.0');
    expect(scan!.deviceCategory).toBe('OTHER');
    expect(scan!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(scan!.ipHash).not.toContain('127.0.0.1');
  });

  it('returns the same 404 for malformed and unknown tokens', async () => {
    const a = await ctx.http().get('/api/v1/public/emergency/short').expect(404);
    const b = await ctx.http().get('/api/v1/public/emergency/AAAAAAAAAAAAAAAAAAAAAA').expect(404);
    expect(a.body.error.code).toBe('HELMET_NOT_FOUND');
    expect(b.body.error.code).toBe('HELMET_NOT_FOUND');
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('invalidates the cached public state when the status changes', async () => {
    await ctx.http().get(`/api/v1/public/emergency/${token}`).expect(200); // warm cache
    await ctx
      .http()
      .patch(`/api/v1/admin/helmets/${helmetId}/status`)
      .set(auth)
      .send({ status: 'DEACTIVATED' })
      .expect(200);
    const res = await ctx.http().get(`/api/v1/public/emergency/${token}`).expect(200);
    expect(res.body.data.state).toBe('DEACTIVATED');
  });

  it('rate limits abusive clients without affecting normal use', async () => {
    await ctx.redis.flushdb();
    const limit = Number(process.env.THROTTLE_PUBLIC_LIMIT);
    for (let i = 0; i < limit; i++)
      await ctx.http().get(`/api/v1/public/emergency/${token}`).expect(200);
    const res = await ctx.http().get(`/api/v1/public/emergency/${token}`).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    // Admin traffic uses a separate bucket.
    await ctx.http().get('/api/v1/admin/dashboard').set(auth).expect(200);
  });
});
