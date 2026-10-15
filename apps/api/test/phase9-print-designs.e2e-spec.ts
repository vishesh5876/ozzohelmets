import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import type { AdminRole } from '@helmet/types';
import {
  FILE_STORAGE_PROVIDER,
  type FileStorageProvider,
} from '../src/modules/file-storage/file-storage.types';
import {
  bearer,
  createAdmin,
  createTestApp,
  login,
  resetState,
  type TestContext,
  waitFor,
} from './utils';

const FIX = join(__dirname, 'fixtures/print');
const BASE_SVG = readFileSync(join(FIX, 'design-base.svg'));
const COVER_SVG = readFileSync(join(FIX, 'design-cover.svg'));

const png = (w: number, h: number, noise = false) =>
  (noise
    ? sharp(Buffer.from(Array.from({ length: w * h * 3 }, () => Math.floor(Math.random() * 256))), {
        raw: { width: w, height: h, channels: 3 },
      })
    : sharp({ create: { width: w, height: h, channels: 3, background: '#C81E28' } })
  )
    .png()
    .toBuffer();

/**
 * Print Designs: admin-controlled artwork, versioning, batch binding, vector/lossless PDF output,
 * malicious-upload rejection, RBAC and audit.
 */
describe('Phase 9 — Print Designs (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp({ PRINT_ARTWORK_PNG_MAX_BYTES: '2000000' });
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetState(ctx);
  });

  const asAdmin = async (role: AdminRole) => {
    const a = await createAdmin(
      ctx,
      role,
      `${role.toLowerCase()}.${Date.now()}.${Math.random()}@test.local`,
    );
    const { token } = await login(ctx, a.email, a.password);
    return { ...a, token };
  };
  const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: unknown) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };
  const upload = (
    token: string,
    buf: Buffer,
    filename: string,
    role = 'base',
    extra: Record<string, string> = {},
  ) => {
    let req = ctx
      .http()
      .post('/api/v1/admin/print-designs/artwork')
      .set(bearer(token))
      .field('role', role);
    for (const [k, v] of Object.entries(extra)) req = req.field(k, v);
    return req.attach('file', buf, {
      filename,
      contentType: filename.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
    });
  };
  const createDesign = async (token: string, name: string, baseId: string, coverId?: string) =>
    (
      await ctx
        .http()
        .post('/api/v1/admin/print-designs')
        .set(bearer(token))
        .send({ name, baseArtworkFileId: baseId, coverArtworkFileId: coverId })
        .expect(201)
    ).body.data;
  const activate = (token: string, id: string) =>
    ctx.http().post(`/api/v1/admin/print-designs/${id}/activate`).set(bearer(token));
  const pdfText = (pdf: Buffer): string[] => {
    const out: string[] = [];
    for (const m of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
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
  async function batch(token: string, quantity: number, printDesignId?: string) {
    const res = await ctx
      .http()
      .post('/api/v1/admin/safety-id-batches')
      .set(bearer(token))
      .send({ mode: 'STANDALONE', quantity, printDesignId });
    if (res.status !== 201) return res;
    const id = res.body.data.id as string;
    await ctx
      .http()
      .post(`/api/v1/admin/safety-id-batches/${id}/generate`)
      .set(bearer(token))
      .expect(202);
    await waitFor(
      () => ctx.prisma.safetyIdBatch.findUniqueOrThrow({ where: { id } }),
      (b) => b.generationStatus === 'COMPLETED',
    );
    return res;
  }
  const printPdf = (token: string, batchId: string) =>
    ctx
      .http()
      .get(`/api/v1/admin/safety-id-batches/${batchId}/export/print.pdf`)
      .set(bearer(token))
      .buffer(true)
      .parse(binary as never);

  it('full lifecycle: SVG v1 → batch → PNG v2 → old batch stays v1, new batch v2; vector & lossless output', async () => {
    const admin = await asAdmin('ADMIN');
    const mfg = await asAdmin('MANUFACTURING');

    const svgFile = (await upload(admin.token, BASE_SVG, 'ozzo-emergency.svg').expect(201)).body
      .data;
    expect(svgFile).toMatchObject({
      format: 'SVG',
      quality: 'VECTOR',
      svgViewBox: '0 0 450 100',
      testOnly: false,
    });
    expect(svgFile.sha256).toMatch(/^[0-9a-f]{64}$/);
    const coverFile = (await upload(admin.token, COVER_SVG, 'cover.svg', 'cover').expect(201)).body
      .data;
    // Same bytes again: deduplicated by SHA-256.
    const again = (await upload(admin.token, BASE_SVG, 'copy.svg').expect(201)).body.data;
    expect(again).toMatchObject({ id: svgFile.id, duplicate: true });

    const v1 = await createDesign(admin.token, 'OZZO Emergency Black', svgFile.id, coverFile.id);
    expect(v1).toMatchObject({
      version: 1,
      status: 'DRAFT',
      artworkType: 'SVG',
      locked: false,
      validationErrors: [],
    });

    // Preview from the production layout engine: exact 4.5 : 1 unit, artwork nested, guides optional.
    const unit = await ctx
      .http()
      .get(`/api/v1/admin/print-designs/${v1.id}/preview/unit.svg?guides=1`)
      .set(bearer(mfg.token))
      .buffer(true)
      .parse(binary as never)
      .expect(200);
    const unitSvg = (unit.body as Buffer).toString();
    expect(unitSvg).toContain('viewBox="0 0 324 72"');
    expect(unitSvg).toMatch(
      /<svg x="0" y="0" width="324" height="72" preserveAspectRatio="xMidYMid meet"/,
    );
    expect(unitSvg).toContain('PIN: 146628');
    expect(unitSvg).toContain('#FF00FF'); // guide: protected target
    const sheet = await ctx
      .http()
      .get(`/api/v1/admin/print-designs/${v1.id}/preview/sheet.svg`)
      .set(bearer(mfg.token))
      .buffer(true)
      .parse(binary as never)
      .expect(200);
    expect((sheet.body as Buffer).toString().match(/<use /g)).toHaveLength(48);

    expect((await activate(admin.token, v1.id).expect(200)).body.data.status).toBe('ACTIVE');

    // Batch A binds v1 (the active default).
    const a = (await batch(mfg.token, 3)).body.data;
    expect(a.printDesign).toMatchObject({ id: v1.id, version: 1 });
    const pdfA = (await printPdf(mfg.token, a.id).expect(200)).body as Buffer;
    const rawA = pdfA.toString('latin1');
    expect(rawA).toContain('/Subtype /Form'); // SVG embedded as vector Form XObject
    expect(rawA).not.toContain('/Subtype /Image'); // never rasterised
    // Each artwork is defined once per PDF and only referenced by every unit.
    const doOps = (pdf: Buffer) =>
      [...pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
        .map((m) => {
          try {
            return inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
          } catch {
            return '';
          }
        })
        .join('\n')
        .match(/\/Art\d+ Do/g) ?? [];
    expect(doOps(pdfA).filter((o) => o === '/Art1 Do')).toHaveLength(3);
    expect(doOps(pdfA).filter((o) => o === '/Art2 Do')).toHaveLength(3);
    expect(pdfText(pdfA).filter((t) => t.startsWith('PIN: '))).toHaveLength(3);
    const auditA = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'safety_id.batch.print_pdf', entityId: a.id },
    });
    expect(auditA.metadata).toMatchObject({
      designId: v1.id,
      designVersion: 1,
      designSha256: { base: svgFile.sha256, cover: coverFile.sha256 },
    });
    expect(auditA.adminId).toBe(mfg.id);

    // v1 is locked now: editing it is refused; a new version is created instead.
    const locked = await ctx
      .http()
      .patch(`/api/v1/admin/print-designs/${v1.id}`)
      .set(bearer(admin.token))
      .send({ scalePercent: 110 })
      .expect(409);
    expect(locked.body.error.code).toBe('PRINT_DESIGN_LOCKED');
    const pngFile = (await upload(admin.token, await png(2700, 600), 'ozzo-v2.png').expect(201))
      .body.data;
    expect(pngFile).toMatchObject({
      format: 'PNG',
      widthPx: 2700,
      heightPx: 600,
      effectiveDpi: 600,
      quality: 'EXCELLENT',
    });
    const v2 = (
      await ctx
        .http()
        .post(`/api/v1/admin/print-designs/${v1.id}/new-version`)
        .set(bearer(admin.token))
        .send({ baseArtworkFileId: pngFile.id, coverArtworkFileId: null })
        .expect(201)
    ).body.data;
    expect(v2).toMatchObject({
      familyId: v1.familyId,
      version: 2,
      status: 'DRAFT',
      artworkType: 'PNG',
      effectiveDpi: 600,
    });
    await activate(admin.token, v2.id).expect(200);
    const v1After = (
      await ctx.http().get(`/api/v1/admin/print-designs/${v1.id}`).set(bearer(admin.token))
    ).body.data;
    expect(v1After).toMatchObject({ status: 'ARCHIVED', usedByBatches: 1, locked: true });

    // Old batch keeps v1 (still vector); new batch gets v2.
    const aAfter = (
      await ctx.http().get(`/api/v1/admin/safety-id-batches/${a.id}`).set(bearer(mfg.token))
    ).body.data;
    expect(aAfter.printDesign).toMatchObject({ id: v1.id, version: 1 });
    expect(
      ((await printPdf(mfg.token, a.id).expect(200)).body as Buffer).toString('latin1'),
    ).not.toContain('/Subtype /Image');
    const b = (await batch(mfg.token, 5)).body.data;
    expect(b.printDesign).toMatchObject({ id: v2.id, version: 2 });
    const rawB = ((await printPdf(mfg.token, b.id).expect(200)).body as Buffer).toString('latin1');
    // PNG embedded once for 5 units, at its own pixel size, lossless Flate (no JPEG, no resize).
    const images = rawB.match(/\/Subtype \/Image[\s\S]*?>>/g) ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/\/Width 2700/);
    expect(images[0]).toMatch(/\/Height 600/);
    expect(images[0]).toMatch(/\/FlateDecode/);
    expect(rawB).not.toContain('/DCTDecode');

    // Archived designs can't be chosen for new batches.
    const archived = await batch(mfg.token, 1, v1.id);
    expect(archived.status).toBe(409);

    const audits = await ctx.prisma.auditLog.findMany({ where: { entityType: 'print_design' } });
    expect(audits.map((x) => x.action)).toEqual(
      expect.arrayContaining([
        'print_design.created',
        'print_design.activated',
        'print_design.version_created',
      ]),
    );
  });

  it('missing or altered artwork fails clearly for an old batch — never substituted', async () => {
    const admin = await asAdmin('ADMIN');
    const file = (await upload(admin.token, BASE_SVG, 'a.svg').expect(201)).body.data;
    const d = await createDesign(admin.token, 'D', file.id);
    await activate(admin.token, d.id).expect(200);
    const b = (await batch(admin.token, 2)).body.data;
    const row = await ctx.prisma.printArtworkFile.findUniqueOrThrow({ where: { id: file.id } });
    const storage = ctx.app.get<FileStorageProvider>(FILE_STORAGE_PROVIDER);

    // Altered bytes (hash mismatch).
    await storage.put(
      row.storageKey,
      Buffer.from(BASE_SVG.toString().replace('#EC1C22', '#000000')),
      'image/svg+xml',
    );
    let res = await printPdf(admin.token, b.id).expect(409);
    expect(JSON.parse((res.body as Buffer).toString()).error).toMatchObject({
      code: 'PRINT_DESIGN_UNAVAILABLE',
      message: 'The print design used by this batch is unavailable.',
    });
    // Missing file.
    await storage.delete(row.storageKey);
    res = await printPdf(admin.token, b.id).expect(409);
    expect(JSON.parse((res.body as Buffer).toString()).error.code).toBe('PRINT_DESIGN_UNAVAILABLE');
    // Activation also re-checks the files.
    const d2 = (
      await ctx
        .http()
        .post(`/api/v1/admin/print-designs/${d.id}/duplicate`)
        .set(bearer(admin.token))
        .expect(201)
    ).body.data;
    expect(d2).toMatchObject({ name: 'D (copy)', version: 1, status: 'DRAFT' });
    expect(d2.familyId).not.toBe(d.familyId);
    expect((await activate(admin.token, d2.id).expect(409)).body.error.code).toBe(
      'PRINT_DESIGN_INVALID',
    );
  });

  it('PNG rules: minimum resolution, test-only (SUPER_ADMIN), aspect, size, wrong type', async () => {
    const admin = await asAdmin('ADMIN');
    const sa = await asAdmin('SUPER_ADMIN');
    const good = (await upload(admin.token, await png(1350, 300), 'min.png').expect(201)).body.data;
    expect(good).toMatchObject({ effectiveDpi: 300, quality: 'GOOD' });

    const low = await upload(admin.token, await png(990, 220), 'low.png').expect(400);
    expect(low.body.error.code).toBe('INVALID_ARTWORK');
    expect(low.body.error.message).toMatch(/220 DPI.*never upscaled/);
    await upload(admin.token, await png(990, 220), 'low.png', 'base', { testOnly: 'true' }).expect(
      400,
    );
    const testOnly = (
      await upload(sa.token, await png(990, 220), 'low.png', 'base', { testOnly: 'true' }).expect(
        201,
      )
    ).body.data;
    expect(testOnly).toMatchObject({ testOnly: true, quality: 'TOO_LOW' });
    const d = await createDesign(sa.token, 'Low', testOnly.id);
    expect(d.validationErrors.join()).toMatch(/test-only/);
    expect((await activate(sa.token, d.id).expect(409)).body.error.code).toBe(
      'PRINT_DESIGN_INVALID',
    );
    // Test print is still allowed for a test-only design.
    await ctx
      .http()
      .get(`/api/v1/admin/print-designs/${d.id}/test-print.pdf`)
      .set(bearer(sa.token))
      .expect(200);

    expect(
      (await upload(admin.token, await png(2700, 700), 'wide.png').expect(400)).body.error.message,
    ).toMatch(/4.5 : 1/);
    expect(
      (await upload(admin.token, await png(2700, 600, true), 'big.png').expect(400)).body.error
        .message,
    ).toMatch(/larger than/);
    // Content decides; a disguised file is refused.
    await upload(admin.token, await png(1350, 300), 'disguised.svg').expect(400);
    await upload(admin.token, BASE_SVG, 'disguised.png').expect(400);
    await upload(admin.token, Buffer.from('GIF89a'), 'x.png').expect(400);
    const corrupt = (await png(1350, 300)).subarray(0, 200);
    await upload(admin.token, corrupt, 'corrupt.png').expect(400);
    // Path traversal in the name is metadata only.
    const trav = (
      await upload(admin.token, await png(1400, 311), '../../etc/passwd.png').expect(201)
    ).body.data;
    expect(trav.originalFilename).toBe('passwd.png');
    const stored = await ctx.prisma.printArtworkFile.findUniqueOrThrow({ where: { id: trav.id } });
    expect(stored.storageKey).toMatch(/^print-designs\/[0-9a-f-]{36}\.png$/);
  });

  it('malicious SVG uploads are rejected and make no external requests', async () => {
    const admin = await asAdmin('ADMIN');
    const wrap = (b: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 450 100">${b}</svg>`;
    for (const [body, msg] of [
      ['<script>fetch("https://evil.example")</script>', /scripts/],
      [
        '<foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example"/></foreignObject>',
        /foreignObject/,
      ],
      [
        '<image href="http://169.254.169.254/latest/meta-data/" width="1" height="1"/>',
        /images are not allowed/,
      ],
      ['<rect width="1" height="1" onload="alert(1)"/>', /Event handler/],
      ['<style>@font-face{font-family:x;src:url(https://evil.example/f.woff)}</style>', /<style>/],
      ['<rect fill="url(https://evil.example/x.svg#p)"/>', /url|External/],
    ] as const) {
      const res = await upload(admin.token, Buffer.from(wrap(body)), 'evil.svg').expect(400);
      expect(res.body.error.code).toBe('INVALID_ARTWORK');
      expect(res.body.error.message).toMatch(msg);
    }
    const bomb = `<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>${wrap('<text>&b;</text>')}`;
    expect(
      (await upload(admin.token, Buffer.from(bomb), 'bomb.svg').expect(400)).body.error.message,
    ).toMatch(/ENTITY/);
    expect(await ctx.prisma.printArtworkFile.count()).toBe(0);
    // Wrong aspect for base artwork: rejected, not stretched.
    await upload(
      admin.token,
      Buffer.from(wrap('').replace('0 0 450 100', '0 0 400 100')),
      'x.svg',
    ).expect(400);
  });

  it('RBAC: SUPPORT none; MANUFACTURING view/use only; ADMIN manage + activate', async () => {
    const support = await asAdmin('SUPPORT');
    const mfg = await asAdmin('MANUFACTURING');
    const admin = await asAdmin('ADMIN');
    await ctx.http().get('/api/v1/admin/print-designs').set(bearer(support.token)).expect(403);
    await ctx.http().get('/api/v1/admin/print-designs').set(bearer(mfg.token)).expect(200);
    await upload(mfg.token, BASE_SVG, 'a.svg').expect(403);
    await upload(support.token, BASE_SVG, 'a.svg').expect(403);
    const file = (await upload(admin.token, BASE_SVG, 'a.svg').expect(201)).body.data;
    const d = await createDesign(admin.token, 'D', file.id);
    await activate(mfg.token, d.id).expect(403);
    await ctx
      .http()
      .post(`/api/v1/admin/print-designs/${d.id}/archive`)
      .set(bearer(mfg.token))
      .expect(403);
    // MANUFACTURING may choose a valid non-archived (draft) design for its batch.
    const b = (await batch(mfg.token, 1, d.id)).body.data;
    expect(b.printDesign).toMatchObject({ id: d.id, version: 1, status: 'DRAFT' });
    // Used drafts can't be deleted; unused ones can.
    await ctx
      .http()
      .delete(`/api/v1/admin/print-designs/${d.id}`)
      .set(bearer(admin.token))
      .expect(409);
    const d3 = await createDesign(admin.token, 'Scratch', file.id);
    await ctx
      .http()
      .delete(`/api/v1/admin/print-designs/${d3.id}`)
      .set(bearer(admin.token))
      .expect(200);
  });

  it('test print: one production-size sheet, sample ID/PIN only, marked TEST PRINT, audited', async () => {
    const admin = await asAdmin('ADMIN');
    const file = (await upload(admin.token, BASE_SVG, 'a.svg').expect(201)).body.data;
    const d = await createDesign(admin.token, 'D', file.id);
    const res = await ctx
      .http()
      .get(`/api/v1/admin/print-designs/${d.id}/test-print.pdf`)
      .set(bearer(admin.token))
      .buffer(true)
      .parse(binary as never)
      .expect(200);
    expect(res.headers['content-disposition']).toMatch(/TEST-PRINT/);
    const raw = (res.body as Buffer).toString('latin1');
    expect(raw.match(/\/MediaBox \[0 0 1296 864\]/g)).toHaveLength(1);
    const text = pdfText(res.body as Buffer);
    expect(text.filter((t) => t === 'TEST PRINT')).toHaveLength(48);
    expect(new Set(text.filter((t) => t.startsWith('PIN: ')))).toEqual(new Set(['PIN: 146628']));
    expect(await ctx.prisma.auditLog.count({ where: { action: 'print_design.test_print' } })).toBe(
      1,
    );
  });

  it('batches created before Print Designs (no design) keep the built-in layout', async () => {
    const mfg = await asAdmin('MANUFACTURING');
    const b = (await batch(mfg.token, 2)).body.data;
    expect(b.printDesign).toBeNull();
    const raw = ((await printPdf(mfg.token, b.id).expect(200)).body as Buffer).toString('latin1');
    expect(raw).not.toContain('/Subtype /Form');
  });
});
