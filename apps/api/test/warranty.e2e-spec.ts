import sharp from 'sharp';
import {
  bearer,
  createAdmin,
  createTestApp,
  createTestHelmet,
  login,
  newCustomer,
  resetState,
  startTransfer,
  type TestContext,
} from './utils';

const ADMIN_PW = 'Test-Password-123';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

async function pngProof(): Promise<Buffer> {
  return sharp({ create: { width: 300, height: 400, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
}
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);
const EVIL_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF\n',
  'latin1',
);

describe('Warranty (e2e)', () => {
  let ctx: TestContext;
  let superAdmin: { token: string };
  let adminRole: { token: string };
  let support: { token: string };
  let manufacturing: { token: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetState(ctx);
    for (const [role, email] of [
      ['SUPER_ADMIN', 'w-super@test.local'],
      ['ADMIN', 'w-admin@test.local'],
      ['SUPPORT', 'w-support@test.local'],
      ['MANUFACTURING', 'w-mfg@test.local'],
    ] as const)
      await createAdmin(ctx, role, email);
    superAdmin = await login(ctx, 'w-super@test.local', ADMIN_PW);
    adminRole = await login(ctx, 'w-admin@test.local', ADMIN_PW);
    support = await login(ctx, 'w-support@test.local', ADMIN_PW);
    manufacturing = await login(ctx, 'w-mfg@test.local', ADMIN_PW);
    // Model policy: 36 months (admin-controlled).
    const model = await ctx.prisma.helmetModel.upsert({
      where: { sku: 'TEST-MODEL' },
      update: {},
      create: { name: 'Roadster X1', sku: 'TEST-MODEL', brand: 'Ozzo' },
    });
    await ctx
      .http()
      .patch(`/api/v1/admin/helmet-models/${model.id}`)
      .set(bearer(superAdmin.token))
      .send({ warrantyEnabled: true, warrantyMonths: 36 })
      .expect(200);
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await ctx.redis.flushdb();
  });

  const url = (helmetId: string) => `/api/v1/customer/helmets/${helmetId}/warranty`;
  const register = (token: string, helmetId: string, body: Record<string, unknown>) =>
    ctx.http().post(url(helmetId)).set(bearer(token)).send(body);
  const adminReauth = async (token: string) =>
    (
      await ctx
        .http()
        .post('/api/v1/admin/auth/reauthenticate')
        .set(bearer(token))
        .send({ password: ADMIN_PW })
        .expect(200)
    ).body.data.recentAuthToken as string;

  it('starts NOT_REGISTERED and computes coverage on the server from the model policy', async () => {
    const c = await newCustomer(ctx);
    const before = await ctx.http().get(url(c.helmet.id)).set(bearer(c.token)).expect(200);
    expect(before.body.data).toMatchObject({
      status: 'NOT_REGISTERED',
      canRegister: true,
      policy: { enabled: true, months: 36 },
    });
    // Client-supplied dates are not accepted at all.
    await register(c.token, c.helmet.id, {
      purchaseDate: '2026-09-10',
      warrantyEndDate: '2099-01-01',
    }).expect(400);
    const res = await register(c.token, c.helmet.id, {
      purchaseDate: '2026-09-10',
      purchaseChannel: 'RETAIL_STORE',
      sellerName: 'Moto Hub',
      sellerCity: 'Pune',
      invoiceNumber: 'INV-1001',
    }).expect(200);
    expect(res.body.data).toMatchObject({
      status: 'ACTIVE',
      source: 'CUSTOMER',
      purchaseDate: '2026-09-10',
      startDate: '2026-09-10',
      endDate: '2029-09-09',
      canRegister: false,
      details: { sellerName: 'Moto Hub', invoiceNumber: 'INV-1001', hasProof: false },
    });
    const history = await ctx.prisma.warrantyHistory.findMany({
      where: { warranty: { helmetId: c.helmet.id } },
    });
    expect(history.map((h) => h.event)).toEqual(['REGISTERED']);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'warranty.registered', entityId: c.helmet.id },
    });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/INV-1001|Moto Hub/);
    const list = await ctx.http().get('/api/v1/customer/helmets').set(bearer(c.token)).expect(200);
    expect(list.body.data[0].warranty).toEqual({ status: 'ACTIVE', endDate: '2029-09-09' });
  });

  it('rejects future and pre-manufacturing purchase dates', async () => {
    const c = await newCustomer(ctx);
    expect(
      (await register(c.token, c.helmet.id, { purchaseDate: daysFromNow(10) }).expect(400)).body
        .error.code,
    ).toBe('INVALID_PURCHASE_DATE');
    await register(c.token, c.helmet.id, { purchaseDate: '2020-01-01' }).expect(400);
    await register(c.token, c.helmet.id, { purchaseDate: daysFromNow(1) }).expect(200); // tolerance
  });

  it('is idempotent and never duplicates (double submit, concurrency, conflicting retry)', async () => {
    const c = await newCustomer(ctx);
    const body = { purchaseDate: '2026-08-01' };
    const results = await Promise.all([
      register(c.token, c.helmet.id, body),
      register(c.token, c.helmet.id, body),
      register(c.token, c.helmet.id, body),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await ctx.prisma.helmetWarranty.count({ where: { helmetId: c.helmet.id } })).toBe(1);
    expect(
      (await register(c.token, c.helmet.id, { purchaseDate: '2026-08-02' }).expect(409)).body.error
        .code,
    ).toBe('WARRANTY_ALREADY_REGISTERED');
  });

  it('only the current owner can register; disabled models and retired helmets cannot', async () => {
    const a = await newCustomer(ctx);
    const b = await newCustomer(ctx);
    await register(b.token, a.helmet.id, { purchaseDate: '2026-09-01' }).expect(404);
    await ctx.http().get(url(a.helmet.id)).set(bearer(b.token)).expect(404);

    await ctx.prisma.helmet.update({ where: { id: a.helmet.id }, data: { status: 'DEACTIVATED' } });
    const view = await ctx.http().get(url(a.helmet.id)).set(bearer(a.token)).expect(200);
    expect(view.body.data.canRegister).toBe(false);
    expect(
      (await register(a.token, a.helmet.id, { purchaseDate: '2026-09-01' }).expect(409)).body.error
        .code,
    ).toBe('WARRANTY_NOT_REGISTRABLE');

    const other = await ctx.prisma.helmetModel.create({
      data: { name: 'No Warranty', sku: `NW-${Date.now()}`, brand: 'Ozzo', warrantyEnabled: false },
    });
    await ctx.prisma.helmet.update({
      where: { id: b.helmet.id },
      data: { helmetModelId: other.id },
    });
    expect(
      (await register(b.token, b.helmet.id, { purchaseDate: '2026-09-01' }).expect(409)).body.error
        .code,
    ).toBe('WARRANTY_NOT_AVAILABLE');
  });

  it('accepts image and PDF proofs by content, rejects others; access is restricted', async () => {
    const c = await newCustomer(ctx);
    await register(c.token, c.helmet.id, { purchaseDate: '2026-09-01' }).expect(200);
    await ctx
      .http()
      .post(`${url(c.helmet.id)}/proof`)
      .set(bearer(c.token))
      .attach('proof', Buffer.from('<script>alert(1)</script>'), 'invoice.png')
      .expect(400);
    await ctx
      .http()
      .post(`${url(c.helmet.id)}/proof`)
      .set(bearer(c.token))
      .attach('proof', EVIL_PDF, 'invoice.pdf')
      .expect(400);
    const png = await ctx
      .http()
      .post(`${url(c.helmet.id)}/proof`)
      .set(bearer(c.token))
      .attach('proof', await pngProof(), 'photo.png')
      .expect(200);
    expect(png.body.data.details.hasProof).toBe(true);
    const pdf = await ctx
      .http()
      .post(`${url(c.helmet.id)}/proof`)
      .set(bearer(c.token))
      .attach('proof', PDF, 'invoice.pdf')
      .expect(200);
    expect(pdf.body.data.details.hasProof).toBe(true);
    const own = await ctx
      .http()
      .get(`${url(c.helmet.id)}/proof`)
      .set(bearer(c.token))
      .expect(200);
    expect(own.headers['content-disposition']).toMatch(/^attachment/);
    expect(own.headers['x-content-type-options']).toBe('nosniff');
    const stored = await ctx.prisma.helmetWarranty.findUniqueOrThrow({
      where: { helmetId: c.helmet.id },
    });
    expect(stored.proofKey).toMatch(/^warranty-proofs\/[0-9a-f-]{36}\.pdf$/);

    // Admin access: SUPPORT yes (audited); ADMIN and MANUFACTURING no.
    const proofUrl = `/api/v1/admin/warranties/${stored.id}/proof`;
    await ctx.http().get(proofUrl).set(bearer(adminRole.token)).expect(403);
    await ctx.http().get(proofUrl).set(bearer(manufacturing.token)).expect(403);
    await ctx
      .http()
      .get(`/api/v1/admin/warranties/${stored.id}`)
      .set(bearer(manufacturing.token))
      .expect(403);
    await ctx.http().get(proofUrl).set(bearer(support.token)).expect(200);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'warranty.proof.viewed', entityId: stored.id },
      }),
    ).toBe(1);

    await ctx
      .http()
      .delete(`${url(c.helmet.id)}/proof`)
      .set(bearer(c.token))
      .expect(200);
    await ctx
      .http()
      .get(`${url(c.helmet.id)}/proof`)
      .set(bearer(c.token))
      .expect(404);
  });

  it('stays with the helmet across a transfer; the previous owner’s private details do not', async () => {
    const a = await newCustomer(ctx);
    const b = await newCustomer(ctx, 'second owner phrase');
    await register(a.token, a.helmet.id, {
      purchaseDate: '2026-09-01',
      invoiceNumber: 'PRIVATE-INV-77',
      notes: 'gift from my uncle',
    }).expect(200);
    await ctx
      .http()
      .post(`${url(a.helmet.id)}/proof`)
      .set(bearer(a.token))
      .attach('proof', PDF, 'invoice.pdf')
      .expect(200);
    const { transferCode } = await startTransfer(ctx, a.token, a.helmet.id);
    await ctx
      .http()
      .post('/api/v1/customer/transfers/claim')
      .set(bearer(b.token))
      .send({ helmetCode: a.helmet.helmetCode, transferCode })
      .expect(200);
    const view = await ctx.http().get(url(a.helmet.id)).set(bearer(b.token)).expect(200);
    expect(view.body.data).toMatchObject({
      status: 'ACTIVE',
      startDate: '2026-09-01',
      endDate: '2029-08-31',
      details: null,
      canRegister: false,
    });
    expect(JSON.stringify(view.body)).not.toMatch(/PRIVATE-INV-77|uncle/);
    await ctx
      .http()
      .get(`${url(a.helmet.id)}/proof`)
      .set(bearer(b.token))
      .expect(404);
    await ctx
      .http()
      .post(`${url(a.helmet.id)}/proof`)
      .set(bearer(b.token))
      .attach('proof', PDF, 'x.pdf')
      .expect(404);
    await ctx.http().get(url(a.helmet.id)).set(bearer(a.token)).expect(404);
  });

  it('admin corrections require a reason and write history + audit; void/restore are permission-gated', async () => {
    const c = await newCustomer(ctx);
    await register(c.token, c.helmet.id, { purchaseDate: '2026-09-01' }).expect(200);
    const w = await ctx.prisma.helmetWarranty.findUniqueOrThrow({
      where: { helmetId: c.helmet.id },
    });
    const base = `/api/v1/admin/warranties/${w.id}`;
    await ctx
      .http()
      .patch(base)
      .set(bearer(support.token))
      .send({ purchaseDate: '2026-08-15' })
      .expect(400);
    const corrected = await ctx
      .http()
      .patch(base)
      .set(bearer(support.token))
      .send({
        purchaseDate: '2026-08-15',
        reasonCode: 'DOCUMENT_VERIFIED',
        note: 'Invoice checked',
      })
      .expect(200);
    expect(corrected.body.data).toMatchObject({
      purchaseDate: '2026-08-15',
      endDate: '2029-08-14',
    });
    expect(corrected.body.data.history[0]).toMatchObject({
      event: 'DATE_CORRECTED',
      reasonCode: 'DOCUMENT_VERIFIED',
      actorName: 'SUPPORT',
      changes: { purchaseDate: { from: '2026-09-01', to: '2026-08-15' } },
    });

    // SUPPORT cannot void; ADMIN can, with a recent password confirmation.
    await ctx
      .http()
      .post(`${base}/void`)
      .set(bearer(support.token))
      .send({ reason: 'INVALID_PURCHASE' })
      .expect(403);
    expect(
      (
        await ctx
          .http()
          .post(`${base}/void`)
          .set(bearer(adminRole.token))
          .send({ reason: 'INVALID_PURCHASE' })
          .expect(403)
      ).body.error.code,
    ).toBe('RECENT_AUTH_REQUIRED');
    const recent = await adminReauth(adminRole.token);
    const voided = await ctx
      .http()
      .post(`${base}/void`)
      .set(bearer(adminRole.token))
      .set('X-Recent-Auth', recent)
      .send({ reason: 'DUPLICATE_REGISTRATION', note: 'Same invoice used twice' })
      .expect(200);
    expect(voided.body.data).toMatchObject({
      status: 'VOID',
      voidReason: 'DUPLICATE_REGISTRATION',
    });
    const customerView = await ctx.http().get(url(c.helmet.id)).set(bearer(c.token)).expect(200);
    expect(customerView.body.data.status).toBe('VOID');
    const restored = await ctx
      .http()
      .post(`${base}/restore`)
      .set(bearer(adminRole.token))
      .send({})
      .expect(200);
    expect(restored.body.data.status).toBe('ACTIVE');
    expect(restored.body.data.history.map((h: { event: string }) => h.event)).toEqual([
      'RESTORED',
      'VOIDED',
      'DATE_CORRECTED',
      'REGISTERED',
    ]);
    expect(
      await ctx.prisma.auditLog.count({
        where: {
          entityId: w.id,
          action: { in: ['warranty.updated', 'warranty.voided', 'warranty.restored'] },
        },
      }),
    ).toBe(3);
  });

  it('derives EXPIRED from the end date (no job needed) and filters/searches in admin', async () => {
    const c = await newCustomer(ctx);
    await register(c.token, c.helmet.id, {
      purchaseDate: '2026-09-01',
      invoiceNumber: 'FIND-ME-9',
    }).expect(200);
    await ctx.prisma.helmetWarranty.update({
      where: { helmetId: c.helmet.id },
      data: {
        purchaseDate: new Date('2023-01-01'),
        warrantyStartDate: new Date('2023-01-01'),
        warrantyEndDate: new Date('2024-01-01'),
      },
    });
    const view = await ctx.http().get(url(c.helmet.id)).set(bearer(c.token)).expect(200);
    expect(view.body.data.status).toBe('EXPIRED');
    const expired = await ctx
      .http()
      .get('/api/v1/admin/warranties?status=EXPIRED')
      .set(bearer(support.token))
      .expect(200);
    expect(expired.body.data.map((w: { helmet: { id: string } }) => w.helmet.id)).toContain(
      c.helmet.id,
    );
    const active = await ctx
      .http()
      .get('/api/v1/admin/warranties?status=ACTIVE')
      .set(bearer(support.token))
      .expect(200);
    expect(active.body.data.map((w: { helmet: { id: string } }) => w.helmet.id)).not.toContain(
      c.helmet.id,
    );
    const { customerCode } = await ctx.prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
    for (const q of [c.helmet.helmetCode, customerCode, 'FIND-ME-9', c.helmet.serialNumber]) {
      const r = await ctx
        .http()
        .get('/api/v1/admin/warranties')
        .query({ search: q })
        .set(bearer(support.token))
        .expect(200);
      expect(r.body.data.map((w: { helmet: { id: string } }) => w.helmet.id)).toContain(
        c.helmet.id,
      );
    }
  });

  it('replacement: original → REPLACED, replacement inherits the original end date (or an override)', async () => {
    const link = (originalHelmetId: string, replacementHelmetCode: string, extra = {}) =>
      ctx
        .http()
        .post('/api/v1/admin/replacements')
        .set(bearer(support.token))
        .send({ originalHelmetId, replacementHelmetCode, reason: 'DAMAGED', ...extra });
    const addHelmet = async (token: string) => {
      const h = await createTestHelmet(ctx, 'SOLD');
      await ctx
        .http()
        .post('/api/v1/customer/activation/add-helmet')
        .set(bearer(token))
        .send({ publicToken: h.publicToken, pin: h.pin })
        .expect(200);
      return h;
    };

    const c = await newCustomer(ctx);
    await register(c.token, c.helmet.id, {
      purchaseDate: '2026-09-01',
      invoiceNumber: 'ORIG-1',
    }).expect(200);
    const replacement = await addHelmet(c.token);
    await link(c.helmet.id, replacement.helmetCode).expect(201);
    const original = await ctx.http().get(url(c.helmet.id)).set(bearer(c.token)).expect(200);
    expect(original.body.data).toMatchObject({
      status: 'REPLACED',
      replacedByHelmetCode: replacement.helmetCode,
    });
    const repl = await ctx.http().get(url(replacement.id)).set(bearer(c.token)).expect(200);
    expect(repl.body.data).toMatchObject({
      status: 'ACTIVE',
      source: 'REPLACEMENT',
      endDate: '2029-08-31',
      replacesHelmetCode: c.helmet.helmetCode,
    });
    // No identity or invoice copied.
    expect(repl.body.data.details).toMatchObject({ invoiceNumber: null, hasProof: false });

    // Override end date.
    const d = await newCustomer(ctx);
    await register(d.token, d.helmet.id, { purchaseDate: '2026-09-01' }).expect(200);
    const r2 = await addHelmet(d.token);
    await link(d.helmet.id, r2.helmetCode, { replacementWarrantyEndDate: '2030-12-31' }).expect(
      201,
    );
    expect(
      (await ctx.http().get(url(r2.id)).set(bearer(d.token)).expect(200)).body.data.endDate,
    ).toBe('2030-12-31');

    // A replacement that already has its own warranty keeps it.
    const e = await newCustomer(ctx);
    await register(e.token, e.helmet.id, { purchaseDate: '2026-09-01' }).expect(200);
    const r3 = await addHelmet(e.token);
    await register(e.token, r3.id, { purchaseDate: daysFromNow(0) }).expect(200);
    const ownEnd = (await ctx.http().get(url(r3.id)).set(bearer(e.token))).body.data.endDate;
    await link(e.helmet.id, r3.helmetCode).expect(201);
    expect((await ctx.http().get(url(r3.id)).set(bearer(e.token))).body.data).toMatchObject({
      endDate: ownEnd,
      source: 'CUSTOMER',
    });

    // A REPLACED helmet can't register a new warranty.
    const f = await newCustomer(ctx);
    const r4 = await addHelmet(f.token);
    await link(f.helmet.id, r4.helmetCode).expect(201);
    await register(f.token, f.helmet.id, { purchaseDate: '2026-09-01' }).expect(409);
  });
});
