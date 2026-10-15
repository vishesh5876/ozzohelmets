import { generateSafetyCode } from '../src/security/helmet-identity.generator';
import { inflateSync } from 'node:zlib';
import type { AdminRole } from '@helmet/types';
import {
  bearer,
  createAdmin,
  createTestApp,
  createTestSafetyId,
  login,
  resetState,
  TEST_PASSWORD,
  type TestContext,
  uniqueEmail,
  waitFor,
} from './utils';

/**
 * Phase 9 final print: six-digit PINs, their activation protections, and the 12 × 18 in 48-up
 * print workflow (generate → CSV → PDF → mark printed → escrow purge), end to end.
 */
describe('Phase 9 — final Safety ID print + six-digit PIN (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({
      TRUST_CLOUDFLARE: 'true',
      // Row lock high so the IP + Safety ID lock is what trips first in these tests.
      ACTIVATION_FAILURES_BEFORE_LOCK: '20',
      ACTIVATION_IP_SAFETY_ID_FAILURES_BEFORE_LOCK: '3',
      ACTIVATION_MAX_FAILURES_PER_IP_PER_HOUR: '50',
      PRINT_LOGO_SVG_PATH: 'test/fixtures/print/test-logo-fixture.svg',
    });
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
  // superagent's parser type wants its own Response type; the stream API is all we use.
  const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: unknown) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };
  /** Text drawn in a (Flate-compressed) pdfkit PDF, in drawing order. */
  const pdfText = (pdf: Buffer): string[] => {
    const raw = pdf.toString('latin1');
    const out: string[] = [];
    for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      let content: string;
      try {
        content = inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
      } catch {
        continue;
      }
      for (const t of content.matchAll(/\[([^\]]*)\]\s*TJ/g))
        out.push(
          [...t[1]!.matchAll(/<([0-9a-fA-F]+)>/g)]
            .map((h) => Buffer.from(h[1]!, 'hex').toString('latin1'))
            .join(''),
        );
    }
    return out;
  };
  const activate = (body: Record<string, unknown>, ip = '203.0.113.10') =>
    ctx
      .http()
      .post('/api/v1/customer/activation/register')
      .set('CF-Connecting-IP', ip)
      .send({ email: uniqueEmail(), password: TEST_PASSWORD, ...body });

  async function generatedBatch(quantity: number) {
    const mfg = await asAdmin('MANUFACTURING');
    const id = (
      await ctx
        .http()
        .post('/api/v1/admin/safety-id-batches')
        .set(bearer(mfg.token))
        .send({ mode: 'STANDALONE', quantity })
        .expect(201)
    ).body.data.id as string;
    await ctx
      .http()
      .post(`/api/v1/admin/safety-id-batches/${id}/generate`)
      .set(bearer(mfg.token))
      .expect(202);
    await waitFor(
      () => ctx.prisma.safetyIdBatch.findUniqueOrThrow({ where: { id } }),
      (b) => b.generationStatus === 'COMPLETED',
      60_000,
    );
    return { id, mfg };
  }
  const csv = async (id: string, token: string) =>
    (
      await ctx
        .http()
        .get(`/api/v1/admin/safety-id-batches/${id}/export/safety-ids.csv`)
        .set(bearer(token))
        .buffer(true)
        .expect(200)
    ).text
      .trim()
      .split('\r\n')
      .slice(1)
      .map((l) => l.split(','));
  const pdf = (id: string, token: string, query = '') =>
    ctx
      .http()
      .get(`/api/v1/admin/safety-id-batches/${id}/export/print.pdf${query}`)
      .set(bearer(token))
      .buffer(true)
      .parse(binary as never);

  describe('six-digit Activation PINs', () => {
    it('new Safety IDs get exactly six digits, stored only as Argon2id hash + encrypted escrow', async () => {
      const { id, mfg } = await generatedBatch(50);
      const rows = await csv(id, mfg.token);
      expect(rows).toHaveLength(50);
      for (const [code, , pin] of rows) {
        expect(pin).toMatch(/^[0-9]{6}$/);
        const s = await ctx.prisma.safetyId.findUniqueOrThrow({
          where: { safetyCode: code },
          include: { activationSecret: true },
        });
        expect(s.activationPinHash.startsWith('$argon2id$')).toBe(true);
        expect(s.activationPinHash).not.toContain(pin!);
        expect(s.activationSecret!.pinCiphertext).not.toContain(pin!);
      }
      // Never in audit metadata.
      const audits = JSON.stringify(await ctx.prisma.auditLog.findMany());
      for (const [, , pin] of rows) expect(audits).not.toContain(`"${pin}"`);
    });

    it('a leading-zero PIN activates as a string; the integer form does not', async () => {
      const s = await createTestSafetyId(ctx, 'PRINTED', '004281');
      const asNumber = await activate({ safetyCode: s.safetyCode, pin: '4281' }).expect(400);
      expect(asNumber.body.error.code).toBe('INVALID_ACTIVATION_PIN');
      await activate({ safetyCode: s.safetyCode, pin: '004 281' }).expect(200);
    });

    it('legacy Phase 1–8 PINs still activate', async () => {
      const s = await createTestSafetyId(ctx, 'PRINTED', 'K7M2PQ9X');
      await activate({ publicToken: s.publicToken, pin: 'k7m2-pq9x' }).expect(200);
    });

    it('unknown Safety ID and wrong PIN give the same safe error', async () => {
      const s = await createTestSafetyId(ctx, 'PRINTED', '146628');
      const wrongPin = await activate({ safetyCode: s.safetyCode, pin: '146629' }).expect(400);
      const unknown = await activate({ safetyCode: generateSafetyCode(), pin: '146628' }).expect(
        400,
      );
      expect({ ...unknown.body.error, requestId: 0 }).toEqual({
        ...wrongPin.body.error,
        requestId: 0,
      });
    });

    it('IP + Safety ID lock: temporary, escalating, other IPs unaffected, cleared on success', async () => {
      const s = await createTestSafetyId(ctx, 'PRINTED', '146628');
      for (let i = 0; i < 2; i++)
        await activate({ safetyCode: s.safetyCode, pin: '000000' }).expect(400);
      const third = await activate({ safetyCode: s.safetyCode, pin: '000001' }).expect(429);
      expect(third.body.error.code).toBe('ACTIVATION_ATTEMPTS_EXCEEDED');
      expect(third.body.error.details.retryAfter).toBeGreaterThan(0);
      // Locked out even with the right PIN from this IP, and the PIN was not checked.
      await activate({ safetyCode: s.safetyCode, pin: '146628' }).expect(429);
      // The owner on another network is not locked out by the attacker (no permanent lock).
      const owner = await activate({ safetyCode: s.safetyCode, pin: '146628' }, '198.51.100.7');
      expect(owner.status).toBe(200);
      const row = await ctx.prisma.safetyId.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.activationAttempts).toBe(0);
      expect(row.activationLockedUntil).toBeNull();
      // The lock key is temporary (has a TTL).
      const keys = await ctx.redis.keys('*activation:ip-sid:*locked');
      expect(keys.length).toBe(1);
      const prefix = process.env.REDIS_KEY_PREFIX ?? '';
      expect(await ctx.redis.ttl(keys[0]!.slice(prefix.length))).toBeGreaterThan(0);
    });

    it('per-Safety-ID lock applies across IPs', async () => {
      const app = await createTestApp({
        TRUST_CLOUDFLARE: 'true',
        ACTIVATION_FAILURES_BEFORE_LOCK: '3',
      });
      try {
        const s = await createTestSafetyId(ctx, 'PRINTED', '146628');
        const post = (pin: string, ip: string) =>
          app
            .http()
            .post('/api/v1/customer/activation/validate')
            .set('CF-Connecting-IP', ip)
            .send({ safetyCode: s.safetyCode, pin });
        await post('000000', '203.0.113.1').expect(400);
        await post('000000', '203.0.113.2').expect(400);
        await post('000000', '203.0.113.3').expect(429);
        await post('146628', '203.0.113.4').expect(429);
        const row = await ctx.prisma.safetyId.findUniqueOrThrow({ where: { id: s.id } });
        expect(row.activationLockedUntil!.getTime()).toBeGreaterThan(Date.now());
        expect(row.activationLockedUntil!.getTime()).toBeLessThan(Date.now() + 86_400_000 + 5000);
      } finally {
        await app.app.close();
      }
    });
  });

  describe('print workflow', () => {
    it('100 units: deterministic order, CSV = PDF, 3 sheets, audited, no-store, permission', async () => {
      const { id, mfg } = await generatedBatch(100);
      const units = await ctx.prisma.safetyId.findMany({
        where: { batchId: id },
        orderBy: { unitIndex: 'asc' },
        select: { unitIndex: true, safetyCode: true, publicToken: true },
      });
      expect(units.map((u) => u.unitIndex)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));

      const rows = await csv(id, mfg.token);
      expect(rows.map((r) => r[0])).toEqual(units.map((u) => u.safetyCode));
      expect(rows.map((r) => r[5])).toEqual(units.map((u) => String(u.unitIndex)));
      expect(rows[47]!.slice(6, 9)).toEqual(['1', '12', '4']);
      expect(rows[48]!.slice(6, 9)).toEqual(['2', '1', '1']);
      expect(rows[99]!.slice(6, 9)).toEqual(['3', '1', '4']);
      for (const [i, r] of rows.entries())
        expect(r[1]).toBe(`https://safe.example.test/e/${units[i]!.publicToken}`);
      expect(new Set(rows.map((r) => r[1])).size).toBe(100);

      const res = await pdf(id, mfg.token).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename=".*48up\.pdf"/);
      expect(res.headers['x-print-sheets']).toBe('3');
      expect(res.headers['x-print-units']).toBe('100');
      const body = res.body as Buffer;
      const raw = body.toString('latin1');
      expect([...raw.matchAll(/\/MediaBox \[0 0 1296 864\]/g)]).toHaveLength(3);
      const text = pdfText(body);
      const pins = text.filter((t) => t.startsWith('PIN: ')).map((t) => t.slice(5));
      expect(pins).toEqual(rows.map((r) => r[2]));
      const ids = text.filter((t) => t.startsWith('ID: ')).map((t) => t.slice(4));
      expect(ids).toEqual(rows.map((r) => r[0]));

      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'safety_id.batch.print_pdf', entityId: id },
      });
      expect(audit.metadata).toMatchObject({ units: 100, pinsIncluded: 100, sheets: 3 });
      expect(JSON.stringify(audit)).not.toMatch(new RegExp(pins.slice(0, 10).join('|')));

      const support = await asAdmin('SUPPORT');
      await pdf(id, support.token).expect(403);
      await ctx
        .http()
        .get(`/api/v1/admin/safety-id-batches/${id}/export/safety-ids.csv`)
        .set(bearer(support.token))
        .expect(403);
      // Exporting does NOT mark the batch printed.
      const after = await ctx.prisma.safetyIdBatch.findUniqueOrThrow({ where: { id } });
      expect(after.printStatus).toBe('NOT_PRINTED');
    });

    it('reprint before purge; mark printed purges escrow; reprint impossible; PIN still activates', async () => {
      const { id, mfg } = await generatedBatch(5);
      const rows = await csv(id, mfg.token);
      const first = pdfText((await pdf(id, mfg.token).expect(200)).body as Buffer);
      const again = pdfText((await pdf(id, mfg.token).expect(200)).body as Buffer);
      expect(again).toEqual(first);

      const detail = await ctx
        .http()
        .get(`/api/v1/admin/safety-id-batches/${id}`)
        .set(bearer(mfg.token))
        .expect(200);
      expect(detail.body.data.exportCount).toBe(3);

      await ctx
        .http()
        .post(`/api/v1/admin/safety-id-batches/${id}/mark-printed`)
        .set(bearer(mfg.token))
        .expect(200);
      expect(
        await ctx.prisma.safetyIdActivationSecret.count({
          where: { safetyIdRef: { batchId: id } },
        }),
      ).toBe(0);
      const refused = await pdf(id, mfg.token).expect(409);
      expect(JSON.parse(refused.body.toString()).error.code).toBe('PIN_ESCROW_PURGED');
      // CSV still lists the units but with no PINs.
      expect((await csv(id, mfg.token)).every((r) => r[2] === '')).toBe(true);

      const [code, , pin] = rows[2]!;
      await activate({ safetyCode: code, pin }).expect(200);
    });

    it('rejects an impossible layout (never scales), accepts a vendor layout', async () => {
      const { id, mfg } = await generatedBatch(3);
      const bad = await pdf(id, mfg.token, '?outerMarginXIn=0.1').expect(400);
      expect(JSON.parse(bad.body.toString()).error.code).toBe('PRINT_LAYOUT_INVALID');
      await pdf(id, mfg.token, '?unitWidthIn=4').expect(400);
      const ok = await pdf(
        id,
        mfg.token,
        '?sheetWidthIn=19&sheetHeightIn=14&outerMarginXIn=0.25&outerMarginYIn=0.25&gutterXIn=0.125&gutterYIn=0.125',
      ).expect(200);
      expect((ok.body as Buffer).toString('latin1')).toContain('/MediaBox [0 0 1368 1008]');
    });

    it('status, previews and cut guide carry no PIN and need admin auth', async () => {
      const support = await asAdmin('SUPPORT');
      await ctx.http().get('/api/v1/admin/safety-id-print/status').expect(401);
      const status = (
        await ctx
          .http()
          .get('/api/v1/admin/safety-id-print/status')
          .set(bearer(support.token))
          .expect(200)
      ).body.data;
      expect(status).toMatchObject({
        preset: '12x18_48UP',
        unitsPerSheet: 48,
        productionReady: true,
        logo: { loaded: true },
        geometry: { unit: { widthMm: 114.3, heightMm: 25.4 } },
      });
      expect(status.fullSheetWarning).toMatch(/48-up uses the full 12 × 18 inch sheet/);
      expect(status.geometry.cover.overlapMm).toBe(1.5);

      const unit = await ctx
        .http()
        .get('/api/v1/admin/safety-id-print/preview/unit.svg')
        .set(bearer(support.token))
        .buffer(true)
        .parse(binary as never)
        .expect(200);
      expect(unit.headers['content-type']).toMatch(/image\/svg\+xml/);
      expect((unit.body as Buffer).toString()).toContain('viewBox="0 0 324 72"');
      const sheet = await ctx
        .http()
        .get('/api/v1/admin/safety-id-print/preview/sheet.svg?filled=4')
        .set(bearer(support.token))
        .buffer(true)
        .parse(binary as never)
        .expect(200);
      expect((sheet.body as Buffer).toString().match(/<use /g)).toHaveLength(4);
      const cut = await ctx
        .http()
        .get('/api/v1/admin/safety-id-print/cut-guide.pdf')
        .set(bearer(support.token))
        .buffer(true)
        .parse(binary as never)
        .expect(200);
      expect(cut.headers['content-type']).toBe('application/pdf');
      expect(pdfText(cut.body as Buffer)).toEqual([]);
    });
  });
});
