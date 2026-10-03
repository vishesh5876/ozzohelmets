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
  reauth,
  resetState,
  type TestContext,
} from './utils';

const ADMIN_PW = 'Test-Password-123';

describe('Product authenticity, product reports & public lifecycle rules (e2e)', () => {
  let ctx: TestContext;
  let superAdmin: { token: string };
  let support: { token: string };
  let manufacturing: { token: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetState(ctx);
    await createAdmin(ctx, 'SUPER_ADMIN', 'a-super@test.local');
    await createAdmin(ctx, 'SUPPORT', 'a-support@test.local');
    await createAdmin(ctx, 'MANUFACTURING', 'a-mfg@test.local');
    superAdmin = await login(ctx, 'a-super@test.local', ADMIN_PW);
    support = await login(ctx, 'a-support@test.local', ADMIN_PW);
    manufacturing = await login(ctx, 'a-mfg@test.local', ADMIN_PW);
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await ctx.redis.flushdb();
  });

  const verify = async (token: string) =>
    (await ctx.http().get(`/api/v1/public/verify/${token}`).expect(200)).body.data;
  const setStatus = (helmetId: string, status: string) =>
    ctx
      .http()
      .patch(`/api/v1/admin/helmets/${helmetId}/status`)
      .set(bearer(superAdmin.token))
      .send({ status })
      .expect(200);

  async function sharingOwner(name: string) {
    const c = await newCustomer(ctx);
    await completeProfile(ctx, c.token, name, 'Sulfa drugs');
    await enableOnHelmet(ctx, c.token, c.helmet.id);
    return c;
  }

  it('verifies a registered identity with safe product data only', async () => {
    const c = await sharingOwner('Kiran Rao');
    await ctx
      .http()
      .post(`/api/v1/customer/helmets/${c.helmet.id}/warranty`)
      .set(bearer(c.token))
      .send({ purchaseDate: '2026-09-15', invoiceNumber: 'SECRET-INV' })
      .expect(200);
    const data = await verify(c.helmet.publicToken);
    expect(data).toMatchObject({
      state: 'VERIFIED',
      product: {
        helmetCode: c.helmet.helmetCode,
        modelName: 'Roadster X1',
        brand: 'Ozzo',
        sku: 'TEST-MODEL',
        manufactured: '2026-01',
      },
      lifecycle: { label: 'In service', warning: null },
      activated: true,
      warranty: { status: 'ACTIVE' },
    });
    expect(data.message).toMatch(/registered identity, not the physical helmet/);
    const json = JSON.stringify(data);
    const helmet = await ctx.prisma.helmet.findUniqueOrThrow({ where: { id: c.helmet.id } });
    for (const leak of [
      'Kiran',
      'Sulfa',
      '9812345678',
      'SECRET-INV',
      c.userId,
      helmet.id,
      helmet.serialNumber,
      helmet.activationPinHash,
      c.helmet.pin,
      c.recoveryCode,
    ])
      expect(json).not.toContain(leak);
    expect(Object.keys(data)).not.toContain('helmetId');
    // Telemetry: one deduplicated VERIFY scan.
    await verify(c.helmet.publicToken);
    await new Promise((r) => setTimeout(r, 200));
    expect(
      await ctx.prisma.helmetScan.count({ where: { helmetId: helmet.id, scanType: 'VERIFY' } }),
    ).toBe(1);
  });

  it('never calls an unknown or malformed token counterfeit', async () => {
    for (const token of ['AAAAAAAAAAAAAAAAAAAAAA', 'not-a-token', 'x'.repeat(22)]) {
      const data = await verify(token);
      expect(data).toEqual({
        state: 'NOT_VERIFIED',
        message: 'We could not verify this Helmet ID. Check the QR code or contact support.',
      });
      expect(JSON.stringify(data).toLowerCase()).not.toContain('counterfeit');
    }
  });

  it('shows lifecycle warnings and reflects warranty changes immediately (cache invalidated)', async () => {
    const c = await newCustomer(ctx);
    expect((await verify(c.helmet.publicToken)).warranty).toEqual({
      status: 'NOT_REGISTERED',
      endsOn: null,
    });
    await ctx
      .http()
      .post(`/api/v1/customer/helmets/${c.helmet.id}/warranty`)
      .set(bearer(c.token))
      .send({ purchaseDate: '2026-09-15' })
      .expect(200);
    expect((await verify(c.helmet.publicToken)).warranty).toEqual({
      status: 'ACTIVE',
      endsOn: '2028-09-14',
    });
    await ctx
      .http()
      .post(`/api/v1/customer/helmets/${c.helmet.id}/lost`)
      .set(bearer(c.token))
      .expect(200);
    expect((await verify(c.helmet.publicToken)).lifecycle).toEqual({
      label: 'Reported lost',
      warning: 'This helmet has been reported lost.',
    });
    const unsold = await createTestHelmet(ctx, 'PRINTED');
    expect(await verify(unsold.publicToken)).toMatchObject({
      state: 'VERIFIED',
      activated: false,
      lifecycle: { label: 'Not yet activated' },
    });
  });

  describe('Phase 4 public emergency rule', () => {
    it('RECALLED keeps the approved profile when already sharing, with a recall warning', async () => {
      const c = await sharingOwner('Neha Joshi');
      await setStatus(c.helmet.id, 'RECALLED');
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view).toMatchObject({
        state: 'RECALLED',
        profile: { name: 'Neha Joshi' },
        warning: expect.stringContaining('recall'),
      });
      expect((await verify(c.helmet.publicToken)).recallWarning).toMatch(/recall/);
    });

    it('DAMAGED/RECALLED without prior sharing (or with the profile off) show no data', async () => {
      const c = await newCustomer(ctx);
      await completeProfile(ctx, c.token, 'Omar Shah');
      await ctx
        .http()
        .post(`/api/v1/customer/helmets/${c.helmet.id}/damaged`)
        .set(bearer(c.token))
        .send({})
        .expect(200);
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view.state).toBe('DAMAGED');
      expect(view.profile).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain('Omar');

      const d = await sharingOwner('Pia Sen');
      await ctx
        .http()
        .post('/api/v1/customer/emergency-profile/disable')
        .set(bearer(d.token))
        .expect(200);
      await setStatus(d.helmet.id, 'RECALLED');
      expect((await publicView(ctx, d.helmet.publicToken)).profile).toBeUndefined();
    });

    it('LOST, STOLEN, REPLACED and DEACTIVATED never show medical information', async () => {
      for (const action of ['lost', 'stolen', 'deactivate'] as const) {
        const c = await sharingOwner('Ravi Hidden');
        const recent = await reauth(ctx, c.token);
        await ctx
          .http()
          .post(`/api/v1/customer/helmets/${c.helmet.id}/${action}`)
          .set(bearer(c.token))
          .set('X-Recent-Auth', recent)
          .send(action === 'deactivate' ? { confirmHelmetCode: c.helmet.helmetCode } : {})
          .expect(200);
        const view = await publicView(ctx, c.helmet.publicToken);
        expect(view.profile).toBeUndefined();
        expect(JSON.stringify(view)).not.toMatch(/Ravi|Sulfa/);
      }
      const c = await sharingOwner('Ravi Hidden');
      const replacement = await createTestHelmet(ctx, 'SOLD');
      await ctx
        .http()
        .post('/api/v1/customer/activation/add-helmet')
        .set(bearer(c.token))
        .send({ publicToken: replacement.publicToken, pin: replacement.pin })
        .expect(200);
      await ctx
        .http()
        .post('/api/v1/admin/replacements')
        .set(bearer(support.token))
        .send({
          originalHelmetId: c.helmet.id,
          replacementHelmetCode: replacement.helmetCode,
          reason: 'DEFECTIVE',
        })
        .expect(201);
      const view = await publicView(ctx, c.helmet.publicToken);
      expect(view.state).toBe('REPLACED');
      expect(view.profile).toBeUndefined();
    });
  });

  describe('product reports', () => {
    it('accepts anonymous reports, links the helmet, and never exposes them publicly', async () => {
      const helmet = await createTestHelmet(ctx, 'SOLD');
      await ctx
        .http()
        .post('/api/v1/public/product-reports')
        .send({
          publicToken: helmet.publicToken,
          reason: 'QR_COPIED',
          description: 'Same QR on two helmets\u0000 at a shop <b>bold</b>',
          contactEmail: 'Reporter@Example.com',
        })
        .expect(202);
      await ctx
        .http()
        .post('/api/v1/public/product-reports')
        .send({ publicToken: 'ZZZZZZZZZZZZZZZZZZZZZZ', reason: 'LOOKS_COUNTERFEIT' })
        .expect(202);
      const rows = await ctx.prisma.productReport.findMany({ orderBy: { createdAt: 'asc' } });
      expect(rows[0]).toMatchObject({
        helmetId: helmet.id,
        contactEmail: 'reporter@example.com',
        status: 'OPEN',
      });
      expect(rows[0]!.description).not.toContain('\u0000');
      expect(rows[1]).toMatchObject({ helmetId: null, publicToken: 'ZZZZZZZZZZZZZZZZZZZZZZ' });
      const audit = await ctx.prisma.auditLog.findMany({
        where: { action: 'product_report.created' },
      });
      expect(JSON.stringify(audit)).not.toMatch(/reporter@|Same QR/);
      await ctx
        .http()
        .post('/api/v1/public/product-reports')
        .send({ reason: 'OTHER', description: 'x'.repeat(1001) })
        .expect(400);
      await ctx
        .http()
        .post('/api/v1/public/product-reports')
        .send({ reason: 'MADE_UP' })
        .expect(400);
    });

    it('is rate limited per IP', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++)
        statuses.push(
          (await ctx.http().post('/api/v1/public/product-reports').send({ reason: 'OTHER' }))
            .status,
        );
      expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
      expect(statuses[5]).toBe(429);
    });

    it('admin review is permission-gated and audited', async () => {
      await ctx
        .http()
        .post('/api/v1/public/product-reports')
        .send({ reason: 'ID_DAMAGED' })
        .expect(202);
      await ctx
        .http()
        .get('/api/v1/admin/product-reports')
        .set(bearer(manufacturing.token))
        .expect(403);
      const list = await ctx
        .http()
        .get('/api/v1/admin/product-reports?status=OPEN')
        .set(bearer(support.token))
        .expect(200);
      const id = list.body.data[0].id as string;
      const updated = await ctx
        .http()
        .patch(`/api/v1/admin/product-reports/${id}`)
        .set(bearer(support.token))
        .send({ status: 'REVIEWING', note: 'Asked the shop for photos' })
        .expect(200);
      expect(updated.body.data).toMatchObject({ status: 'REVIEWING', reviewedByName: 'SUPPORT' });
      await ctx
        .http()
        .patch(`/api/v1/admin/product-reports/${id}`)
        .set(bearer(manufacturing.token))
        .send({ status: 'DISMISSED' })
        .expect(403);
      expect(
        await ctx.prisma.auditLog.count({
          where: { action: 'product_report.status_changed', entityId: id },
        }),
      ).toBe(1);
    });
  });
});
