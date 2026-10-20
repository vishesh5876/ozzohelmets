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
    // Phase 9: a helmet batch generates one linked Safety ID per helmet; the QR is the Safety ID's.
    const helmet = await ctx.prisma.helmet.findFirstOrThrow({
      include: { safetyIdLinks: { include: { safetyIdRef: true } } },
    });
    token = helmet.safetyIdLinks[0]!.safetyIdRef.publicToken;
    expect(helmet.publicToken).toBe(token); // mirrored for rollback compatibility
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
        safetyId: {},
        linkedProduct: true,
        message: 'This Safety ID has not been activated yet.',
      },
    });
    const raw = JSON.stringify(res.body);
    const helmet = await ctx.prisma.helmet.findUniqueOrThrow({
      where: { id: helmetId },
      include: { safetyIdLinks: { include: { safetyIdRef: true } } },
    });
    const safety = helmet.safetyIdLinks[0]!.safetyIdRef;
    // No product data on the person-focused page, and nothing internal.
    for (const secret of [
      helmet.id,
      helmet.helmetCode,
      helmet.serialNumber,
      helmet.batchId,
      safety.id,
      safety.activationPinHash,
      'Urban Jet',
      'UJ-1',
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
      () =>
        ctx.prisma.helmetScan.findFirst({
          where: { helmetId, scanType: 'EMERGENCY_PAGE', deviceCategory: { not: null } },
          include: { safetyIdRef: { select: { publicToken: true } } },
        }),
      (s) => s !== null,
    );
    expect(scan!.scanType).toBe('EMERGENCY_PAGE');
    // Phase 9: every scan records the Safety ID and the helmet linked at scan time.
    expect(scan!.safetyIdRef?.publicToken).toBe(token);
    // Only a coarse summary and device class are kept, never the raw User-Agent string.
    expect(scan!.userAgent).not.toBe('EmergencyTest/1.0');
    expect(scan!.deviceCategory).toBe('OTHER');
    expect(scan!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(scan!.ipHash).not.toContain('127.0.0.1');
  });

  it('returns the same 404 for malformed and unknown tokens', async () => {
    const a = await ctx.http().get('/api/v1/public/emergency/short').expect(404);
    const b = await ctx.http().get('/api/v1/public/emergency/AAAAAAAAAAAAAAAAAAAAAA').expect(404);
    expect(a.body.error.code).toBe('SAFETY_ID_NOT_FOUND');
    expect(b.body.error.code).toBe('SAFETY_ID_NOT_FOUND');
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('serves the whole emergency page as one server-rendered HTML response', async () => {
    const res = await ctx
      .http()
      .get(`/api/v1/public/emergency/${token}/page`)
      .set('User-Agent', 'EmergencyPageTest/1.0')
      .expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toMatch(/script-src 'sha256-/);
    expect(res.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
    expect(res.text).toContain('Safety ID not activated');
    expect(res.text).toContain(`href="/activate?t=${token}"`);
    expect(res.text).toContain('id="call-emergency"');
    expect(res.text).not.toContain('Urban Jet');
    // Same scan logging as the JSON endpoint.
    await waitFor(
      () => ctx.prisma.helmetScan.count({ where: { helmetId, scanType: 'EMERGENCY_PAGE' } }),
      (n) => n >= 3,
    );
  });

  it('renders unknown tokens as an HTML 404 that still offers the emergency call', async () => {
    const res = await ctx.http().get('/api/v1/public/emergency/AAAAAAAAAAAAAAAAAAAAAA/page');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toContain('We could not find this Safety ID');
    expect(res.text).toContain('href="tel:');
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
    // The HTML page has its own bucket and answers a throttled client with a readable page.
    for (let i = 0; i < limit; i++)
      await ctx.http().get(`/api/v1/public/emergency/${token}/page`).expect(200);
    const page = await ctx.http().get(`/api/v1/public/emergency/${token}/page`).expect(429);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.text).toContain('Please wait a moment');
    // Admin traffic uses a separate bucket.
    await ctx.http().get('/api/v1/admin/dashboard').set(auth).expect(200);
  });
});
