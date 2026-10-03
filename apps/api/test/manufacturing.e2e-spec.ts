import { isValidHelmetCode } from '@helmet/types';
import { EncryptionService } from '../src/security/encryption.service';
import { createAdmin, createTestApp, login, resetState, type TestContext, waitFor } from './utils';

/**
 * Phase 1 milestone: model → batch → generate → list/search → labels → CSV export
 * → public QR resolution → mark printed (escrow purge).
 */
describe('Manufacturing flow (e2e)', () => {
  let ctx: TestContext;
  let auth: { Authorization: string };
  let modelId: string;
  let batchId: string;
  const QUANTITY = 150; // > chunk size (40) to exercise chunking

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetState(ctx);
    const admin = await createAdmin(ctx, 'ADMIN');
    auth = { Authorization: `Bearer ${(await login(ctx, admin.email, admin.password)).token}` };
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('creates a helmet model (SKU normalised and unique)', async () => {
    const res = await ctx
      .http()
      .post('/api/v1/admin/helmet-models')
      .set(auth)
      .send({ name: 'Roadster X1', sku: 'rx1-test', brand: 'Ozzo' })
      .expect(201);
    expect(res.body.data).toMatchObject({ sku: 'RX1-TEST', status: 'ACTIVE', helmetCount: 0 });
    modelId = res.body.data.id;
    const dup = await ctx
      .http()
      .post('/api/v1/admin/helmet-models')
      .set(auth)
      .send({ name: 'Dup', sku: 'RX1-TEST', brand: 'Ozzo' })
      .expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('creates a batch with a generated BAT-YYYY-NNNNN code and enforces limits', async () => {
    const res = await ctx
      .http()
      .post('/api/v1/admin/batches')
      .set(auth)
      .send({ helmetModelId: modelId, manufacturingDate: '2026-10-01', quantity: QUANTITY })
      .expect(201);
    expect(res.body.data.batchCode).toMatch(/^BAT-2026-\d{5}$/);
    expect(res.body.data).toMatchObject({
      quantity: QUANTITY,
      generatedCount: 0,
      generationStatus: 'PENDING',
      manufacturingDate: '2026-10-01',
    });
    batchId = res.body.data.id;
    await ctx
      .http()
      .post('/api/v1/admin/batches')
      .set(auth)
      .send({ helmetModelId: modelId, manufacturingDate: '2026-10-01', quantity: 5000 })
      .expect(400);
    await ctx
      .http()
      .post('/api/v1/admin/batches')
      .set(auth)
      .send({ helmetModelId: modelId, manufacturingDate: '2026-10-01', quantity: 0 })
      .expect(400);
  });

  it('generates helmets exactly once, even with concurrent requests', async () => {
    const [a, b] = await Promise.all([
      ctx.http().post(`/api/v1/admin/batches/${batchId}/generate`).set(auth),
      ctx.http().post(`/api/v1/admin/batches/${batchId}/generate`).set(auth),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);

    const done = await waitFor(
      () =>
        ctx
          .http()
          .get(`/api/v1/admin/batches/${batchId}`)
          .set(auth)
          .then((r) => r.body.data),
      (d: { generationStatus: string }) => d.generationStatus !== 'GENERATING',
    );
    expect(done).toMatchObject({
      generationStatus: 'COMPLETED',
      generatedCount: QUANTITY,
      pinsEscrowed: QUANTITY,
    });

    const again = await ctx
      .http()
      .post(`/api/v1/admin/batches/${batchId}/generate`)
      .set(auth)
      .expect(409);
    expect(again.body.error.code).toBe('BATCH_ALREADY_GENERATED');
  });

  it('persists unique, well-formed identities with hashed PINs only', async () => {
    const helmets = await ctx.prisma.helmet.findMany({ where: { batchId } });
    expect(helmets).toHaveLength(QUANTITY);
    expect(new Set(helmets.map((h) => h.helmetCode)).size).toBe(QUANTITY);
    expect(new Set(helmets.map((h) => h.publicToken)).size).toBe(QUANTITY);
    expect(new Set(helmets.map((h) => h.serialNumber)).size).toBe(QUANTITY);
    for (const h of helmets) {
      expect(isValidHelmetCode(h.helmetCode)).toBe(true);
      expect(h.publicToken).toMatch(/^[0-9A-Za-z]{22}$/);
      expect(h.activationPinHash.startsWith('$argon2id$')).toBe(true);
      expect(h.activationPinUsed).toBe(false);
      expect(h.status).toBe('GENERATED');
    }
    const history = await ctx.prisma.helmetStatusHistory.count({
      where: { helmet: { batchId }, toStatus: 'GENERATED', actorType: 'SYSTEM' },
    });
    expect(history).toBe(QUANTITY);
  });

  it('lists, filters and searches helmets', async () => {
    const page = await ctx
      .http()
      .get('/api/v1/admin/helmets')
      .query({ batchId, pageSize: 50 })
      .set(auth)
      .expect(200);
    expect(page.body.data).toHaveLength(50);
    expect(page.body.meta).toMatchObject({ page: 1, pageSize: 50, total: QUANTITY, totalPages: 3 });
    expect(page.body.data[0].publicToken).toBeUndefined();
    expect(page.body.data[0].activationPinHash).toBeUndefined();

    const target = page.body.data[7];
    const byCode = await ctx
      .http()
      .get('/api/v1/admin/helmets')
      .query({ search: target.helmetCode.toLowerCase().replace(/-/g, '') })
      .set(auth)
      .expect(200);
    expect(byCode.body.data.map((h: { id: string }) => h.id)).toEqual([target.id]);

    const bySerial = await ctx
      .http()
      .get('/api/v1/admin/helmets')
      .query({ search: target.serialNumber })
      .set(auth)
      .expect(200);
    expect(bySerial.body.data[0].id).toBe(target.id);

    const byStatus = await ctx
      .http()
      .get('/api/v1/admin/helmets')
      .query({ status: 'ACTIVE,LOST' })
      .set(auth)
      .expect(200);
    expect(byStatus.body.meta.total).toBe(0);
    await ctx.http().get('/api/v1/admin/helmets').query({ status: 'BOGUS' }).set(auth).expect(400);
  });

  it('returns helmet detail with QR URL and renders QR/barcode labels', async () => {
    const helmet = await ctx.prisma.helmet.findFirstOrThrow({ where: { batchId } });
    const detail = await ctx.http().get(`/api/v1/admin/helmets/${helmet.id}`).set(auth).expect(200);
    expect(detail.body.data.qrUrl).toBe(`https://safe.example.test/e/${helmet.publicToken}`);
    expect(detail.body.data).toMatchObject({
      pinEscrowed: true,
      activationPinUsed: false,
      allowedTransitions: ['PRINTED', 'DEACTIVATED'],
    });

    const svg = await ctx.http().get(`/api/v1/admin/helmets/${helmet.id}/qr`).set(auth).expect(200);
    expect(svg.headers['content-type']).toMatch(/image\/svg\+xml/);
    const png = await ctx
      .http()
      .get(`/api/v1/admin/helmets/${helmet.id}/qr?format=png`)
      .set(auth)
      .buffer(true)
      .expect(200);
    expect(png.headers['content-type']).toBe('image/png');
    const barcode = await ctx
      .http()
      .get(`/api/v1/admin/helmets/${helmet.id}/barcode`)
      .set(auth)
      .expect(200);
    expect(barcode.headers['content-type']).toMatch(/image\/svg\+xml/);
  });

  it('exports a manufacturing CSV with decryptable PINs that match their hashes, and audits it', async () => {
    const res = await ctx
      .http()
      .get(`/api/v1/admin/batches/${batchId}/export/manufacturing.csv`)
      .set(auth)
      .buffer(true)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="BAT-2026-\d{5}-manufacturing.csv"/,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('helmetCode,serialNumber,model,batchCode,qrUrl,activationPin');
    expect(lines).toHaveLength(QUANTITY + 1);

    const [helmetCode, , model, , qrUrl, pin] = lines[1]!.split(',');
    expect(model).toBe('Roadster X1');
    expect(pin).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    const helmet = await ctx.prisma.helmet.findUniqueOrThrow({ where: { helmetCode } });
    expect(qrUrl).toBe(`https://safe.example.test/e/${helmet.publicToken}`);
    await expect(ctx.hashing.verifyPin(helmet.activationPinHash, pin!)).resolves.toBe(true);

    // Escrow ciphertext is bound to its helmet: it cannot be decrypted for another row.
    const secret = await ctx.prisma.helmetActivationSecret.findUniqueOrThrow({
      where: { helmetId: helmet.id },
    });
    expect(secret.pinCiphertext).not.toContain(pin);
    expect(() =>
      ctx.app.get(EncryptionService).pinEscrow.decrypt(secret.pinCiphertext, 'another-helmet'),
    ).toThrow();

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'batch.export.manufacturing_csv', entityId: batchId },
    });
    expect(audit.metadata).toMatchObject({ pinsIncluded: QUANTITY });
    expect(JSON.stringify(audit.metadata)).not.toContain(pin);
  });

  it('enforces lifecycle transitions on admin status changes', async () => {
    const helmet = await ctx.prisma.helmet.findFirstOrThrow({
      where: { batchId },
      orderBy: { serialNumber: 'desc' },
    });
    const bad = await ctx
      .http()
      .patch(`/api/v1/admin/helmets/${helmet.id}/status`)
      .set(auth)
      .send({ status: 'SOLD' })
      .expect(409);
    expect(bad.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    expect(bad.body.error.details.allowed).toEqual(['PRINTED', 'DEACTIVATED']);

    const activate = await ctx
      .http()
      .patch(`/api/v1/admin/helmets/${helmet.id}/status`)
      .set(auth)
      .send({ status: 'ACTIVATED' })
      .expect(409);
    expect(activate.body.error.code).toBe('INVALID_STATUS_TRANSITION');

    const ok = await ctx
      .http()
      .patch(`/api/v1/admin/helmets/${helmet.id}/status`)
      .set(auth)
      .send({ status: 'DEACTIVATED', reason: 'QC reject' })
      .expect(200);
    expect(ok.body.data.status).toBe('DEACTIVATED');
    expect(ok.body.data.statusHistory[0]).toMatchObject({
      fromStatus: 'GENERATED',
      toStatus: 'DEACTIVATED',
      actorType: 'ADMIN',
      reason: 'QC reject',
    });
  });

  it('marks the batch printed: helmets → PRINTED, PIN escrow purged, export has no PINs', async () => {
    const res = await ctx
      .http()
      .post(`/api/v1/admin/batches/${batchId}/mark-printed`)
      .set(auth)
      .expect(200);
    expect(res.body.data).toMatchObject({ printStatus: 'PRINTED', pinsEscrowed: 0 });
    expect(await ctx.prisma.helmetActivationSecret.count()).toBe(0);
    expect(await ctx.prisma.helmet.count({ where: { batchId, status: 'PRINTED' } })).toBe(
      QUANTITY - 1,
    );
    expect(await ctx.prisma.helmet.count({ where: { batchId, status: 'DEACTIVATED' } })).toBe(1);
    await ctx.http().post(`/api/v1/admin/batches/${batchId}/mark-printed`).set(auth).expect(409);

    const csv = await ctx
      .http()
      .get(`/api/v1/admin/batches/${batchId}/export/manufacturing.csv`)
      .set(auth)
      .buffer(true)
      .expect(200);
    expect(csv.headers['x-pins-included']).toBe('0');
    expect(
      csv.text
        .trim()
        .split('\r\n')
        .slice(1)
        .every((line) => line.endsWith(',')),
    ).toBe(true);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'batch.pin_escrow.purged' } })).toBe(
      1,
    );
  });
});
