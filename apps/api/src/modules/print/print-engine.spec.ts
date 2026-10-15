import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import jsQR from 'jsqr';
import sharp from 'sharp';
import {
  DEFAULT_PRINT_LAYOUT,
  FULL_SHEET_WARNING,
  mmToPt,
  needsFullSheetWarning,
  placeUnit,
  planSheets,
  type PrintSheetLayout,
  unitsPerSheet,
  validatePrintLayout,
} from '@helmet/types';
import { planCuts } from './cut-lines';
import { LogoAssetError, OZZO_RED, parseLogoSvg } from './logo-asset';
import { createTextMetrics, cutGuidePdf, SheetPdf } from './pdf-renderer';
import { COVER_OVERLAP, CUT_TOL, STICKER_DESIGN, UNIT_H, UNIT_W } from './sticker-design';
import {
  boxesOverlap,
  computeStickerGeometry,
  type DrawElement,
  elementBounds,
  geometryIssues,
  layoutUnit,
  type UnitData,
} from './sticker-layout';
import { unitSvg } from './svg-renderer';

const FIXTURE = join(__dirname, '../../../test/fixtures/print/test-logo-fixture.svg');
const fonts = { regularPath: null, boldPath: null };
const metrics = createTextMetrics(fonts);
const logo = parseLogoSvg(readFileSync(FIXTURE, 'utf8'), 'fixture');
const geometry = computeStickerGeometry(2, metrics);
const ctx = { geometry, metrics, logo };
const URL = 'https://safe.ozzohelmets.com/e/';
const unit = (i: number): UnitData => ({
  safetyCode: 'SI-CD69-GXXR',
  pin: String((i * 7919) % 1_000_000).padStart(6, '0'),
  qrPayload: `${URL}${String(i).padStart(22, 'A')}`,
});
const mm = (pt: number) => (pt * 25.4) / 72;

/** Renders a PDF fully into memory (uncompressed, so content streams are inspectable). */
async function pdfBuffer(count: number, layout = DEFAULT_PRINT_LAYOUT): Promise<string> {
  const pdf = new SheetPdf({ layout, fonts, title: 't', compress: false });
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) =>
    pdf.doc.pipe(
      new Writable({
        write(c: Buffer, _e, cb) {
          chunks.push(c);
          cb();
        },
        final(cb) {
          resolve();
          cb();
        },
      }),
    ),
  );
  for (let i = 0; i < count; i++) pdf.addUnit(i, layoutUnit(unit(i), ctx));
  pdf.end();
  await done;
  return Buffer.concat(chunks).toString('latin1');
}

/** Text shown in a pdfkit content stream (hex-encoded WinAnsi strings in TJ arrays). */
const shownText = (pdf: string): string[] =>
  [...pdf.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((m) =>
    [...m[1]!.matchAll(/<([0-9a-fA-F]+)>/g)]
      .map((h) => Buffer.from(h[1]!, 'hex').toString('latin1'))
      .join(''),
  );

describe('print geometry (4.5 × 1 in unit, cover inside the unit)', () => {
  it('unit is exactly 324 × 72 pt and zones add up to 4.5 in (not 5.5)', () => {
    expect(UNIT_W).toBe(324);
    expect(UNIT_H).toBe(72);
    const z = geometry.zones;
    expect(z.emergency.w + z.credential.w + z.cover.w).toBeCloseTo(324, 6);
    expect(z.emergency.w).toBeCloseTo(158.4, 6);
    expect(z.credential.w).toBeCloseTo(82.8, 6);
    // The cover zone is the right third of the SAME unit, not an extra inch.
    expect(z.cover.x + z.cover.w).toBeCloseTo(324, 6);
  });

  it('satisfies every cover/target rule', () => {
    expect(geometryIssues(geometry)).toEqual([]);
  });

  it('cover fully covers the protected target (PIN + QR + quiet zone) with 1–2 mm overlap', () => {
    const { target, qrBox, coverDie, coverFootprint } = geometry;
    expect(coverDie.w).toBeCloseTo(target.w + 2 * COVER_OVERLAP, 6);
    expect(coverDie.h).toBeCloseTo(target.h + 2 * COVER_OVERLAP, 6);
    expect(mm(COVER_OVERLAP)).toBeGreaterThanOrEqual(1);
    expect(mm(COVER_OVERLAP)).toBeLessThanOrEqual(2);
    expect(coverFootprint.w).toBeCloseTo(coverDie.w, 6);
    // QR (with quiet zone) is inside the target, and the PIN is inside it too.
    expect(qrBox.x).toBeGreaterThanOrEqual(target.x - 1e-6);
    expect(qrBox.y + qrBox.h).toBeLessThanOrEqual(target.y + target.h + 1e-6);
    const pin = layoutUnit(unit(1), ctx).find((e) => e.role === 'pin')!;
    const pb = elementBounds(pin);
    expect(pb.x).toBeGreaterThanOrEqual(target.x);
    expect(pb.x + pb.w).toBeLessThanOrEqual(target.x + target.w);
    expect(pb.y).toBeGreaterThanOrEqual(target.y - 1e-6);
  });

  it('applied cover stays on the base sticker and off the emergency panel and Safety ID', () => {
    const f = geometry.coverFootprint;
    expect(f.y).toBeGreaterThanOrEqual(CUT_TOL - 1e-6);
    expect(f.y + f.h).toBeLessThanOrEqual(UNIT_H - CUT_TOL + 1e-6);
    expect(f.x).toBeGreaterThan(geometry.zones.credential.x);
    const id = elementBounds(layoutUnit(unit(1), ctx).find((e) => e.role === 'safety-code')!);
    expect(id.x + id.w).toBeLessThan(f.x);
  });

  it('QR is as large as the geometry allows, with a 4-module quiet zone of real modules', () => {
    const qr = layoutUnit(unit(1), ctx).find((e) => e.kind === 'qr')!;
    if (qr.kind !== 'qr') throw new Error();
    const module = qr.size / (qr.matrix.size + 2 * qr.quietZoneModules);
    expect(qr.quietZoneModules).toBe(4);
    expect(mm(qr.size)).toBeGreaterThan(18.5);
    expect(mm(module)).toBeGreaterThanOrEqual(0.33);
  });

  it('nothing intrudes into the QR or its quiet zone; everything stays inside the unit', () => {
    for (let i = 0; i < 20; i++) {
      const els = layoutUnit(unit(i), ctx);
      const qrBox = geometry.qrBox;
      for (const el of els) {
        const b = elementBounds(el);
        expect(b.x).toBeGreaterThanOrEqual(-1e-6);
        expect(b.y).toBeGreaterThanOrEqual(-1e-6);
        expect(b.x + b.w).toBeLessThanOrEqual(UNIT_W + 1e-6);
        expect(b.y + b.h).toBeLessThanOrEqual(UNIT_H + 1e-6);
        if (el.role !== 'qr' && el.role !== 'qr-backing')
          expect(boxesOverlap(b, qrBox)).toBe(false);
      }
    }
  });

  it('text and logo respect the safe area from every cut edge', () => {
    const safe = mmToPt(2);
    for (const el of layoutUnit(unit(3), ctx)) {
      if (el.kind !== 'text' && el.kind !== 'logo') continue;
      if (el.role.startsWith('cover')) continue; // inside the cover die, checked below
      const b = elementBounds(el);
      expect(b.x).toBeGreaterThanOrEqual(safe - 1e-6);
      expect(b.y).toBeGreaterThanOrEqual(safe - 1e-6);
      expect(b.y + b.h).toBeLessThanOrEqual(UNIT_H - safe + 1e-6);
      expect(b.x + b.w).toBeLessThanOrEqual(geometry.zones.cover.x - 1e-6);
    }
  });

  it('the cover carries no PIN, QR, Safety ID or helmet data — only emergency instructions', () => {
    const els = layoutUnit(unit(4), ctx);
    const cover = geometry.coverYellow;
    const onCover = els.filter((e) => boxesOverlap(elementBounds(e), cover));
    expect(onCover.every((e) => e.role.startsWith('cover'))).toBe(true);
    const words = onCover.flatMap((e) => (e.kind === 'text' ? [e.text] : []));
    expect(words).toEqual(['REMOVE', 'ONLY IN', 'EMERGENCY', 'OPEN']);
  });

  it('logo: uniform scale only, first Z exactly #EC1C22, other letters black', () => {
    const el = layoutUnit(unit(1), ctx).find((e) => e.kind === 'logo')!;
    if (el.kind !== 'logo') throw new Error();
    const b = elementBounds(el);
    expect(b.w / b.h).toBeCloseTo(logo.viewBox.width / logo.viewBox.height, 9);
    expect(el.logo.paths.find((p) => p.letter === 'z1')!.fill).toBe('#EC1C22');
    expect(OZZO_RED).toBe('#EC1C22');
    for (const l of ['o1', 'z2', 'o2'])
      expect(el.logo.paths.filter((p) => p.letter === l).every((p) => p.fill === '#000000')).toBe(
        true,
      );
  });

  it('logo loader rejects anything that could distort the supplied artwork', () => {
    const ok = readFileSync(FIXTURE, 'utf8');
    expect(() => parseLogoSvg(ok.replace('<path id="ozzo-z2"', '<path id="ozzo-x"'), 'x')).toThrow(
      LogoAssetError,
    );
    expect(() =>
      parseLogoSvg(
        ok.replace('<path id="ozzo-o1"', '<path transform="scale(2 1)" id="ozzo-o1"'),
        'x',
      ),
    ).toThrow(/Transforms/);
    expect(() => parseLogoSvg(ok.replace(/<path id="ozzo-o2"[^>]*>/, ''), 'x')).toThrow(/missing/);
    expect(() =>
      parseLogoSvg(ok.replace('</svg>', '<rect width="1" height="1"/></svg>'), 'x'),
    ).toThrow(/Only <path>/);
    expect(() => parseLogoSvg(ok.replace(/viewBox="[^"]*"/, ''), 'x')).toThrow(/viewBox/);
  });
});

describe('PIN on the sticker', () => {
  it('prints the PIN as a string with its leading zeros', () => {
    const els = layoutUnit({ ...unit(1), pin: '004281' }, ctx);
    const pin = els.find((e) => e.role === 'pin');
    expect(pin?.kind === 'text' && pin.text).toBe('PIN: 004281');
  });

  it('six-digit PINs print at the full design size', () => {
    for (const pin of ['000000', '146628', '999999']) {
      const el = layoutUnit({ ...unit(1), pin }, ctx).find((e) => e.role === 'pin');
      expect(el?.kind === 'text' && el.size).toBe(STICKER_DESIGN.pin.fontPt);
    }
  });

  it('even the widest legacy 8-symbol PIN still fits the credential block', () => {
    const el = layoutUnit({ ...unit(1), pin: 'WWWWWWWW' }, ctx).find((e) => e.role === 'pin');
    if (el?.kind !== 'text') throw new Error();
    expect(el.size).toBeGreaterThanOrEqual(5);
    expect(el.width).toBeLessThanOrEqual(geometry.target.w);
  });
});

describe('QR content (decoded from the rendered artwork)', () => {
  it('encodes the exact Safety ID URL and decodes after rasterising', async () => {
    const data = { ...unit(1), qrPayload: `${URL}Zx81QpLm0aBcDeFgHiJkLm` };
    const svg = unitSvg(layoutUnit(data, ctx));
    // Rasterise, then crop to the credential panel (what a phone camera frames).
    const raster = await sharp(Buffer.from(svg), { density: 150 }).png().toBuffer();
    const k = (await sharp(raster).metadata()).width! / UNIT_W;
    const { qrBox } = geometry;
    const { data: px, info } = await sharp(raster)
      .extract({
        left: Math.floor((qrBox.x - 4) * k),
        top: Math.floor((qrBox.y - 4) * k),
        width: Math.ceil((qrBox.w + 8) * k),
        height: Math.ceil((qrBox.h + 4) * k),
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const decoded = jsQR(new Uint8ClampedArray(px), info.width, info.height);
    expect(decoded?.data).toBe(data.qrPayload);
  });
});

describe('48-up sheet math', () => {
  it('default preset: 12 × 18 in landscape, 4 × 12 = 48 units, zero margin and gutter', () => {
    const l = DEFAULT_PRINT_LAYOUT;
    expect([l.sheetWidthIn, l.sheetHeightIn]).toEqual([18, 12]);
    expect([l.columns, l.rows, unitsPerSheet(l)]).toEqual([4, 12, 48]);
    expect([l.outerMarginXIn, l.outerMarginYIn, l.gutterXIn, l.gutterYIn]).toEqual([0, 0, 0, 0]);
    expect(validatePrintLayout(l)).toEqual([]);
    expect(needsFullSheetWarning(l)).toBe(true);
    expect(FULL_SHEET_WARNING).toContain('48-up uses the full 12 × 18 inch sheet');
  });

  it.each([
    [1, 1, 0, 1],
    [4, 1, 0, 4],
    [47, 1, 0, 47],
    [48, 1, 1, 48],
    [49, 2, 1, 1],
    [96, 2, 2, 48],
    [100, 3, 2, 4],
    [1000, 21, 20, 40],
    [5000, 105, 104, 8],
  ])('%i units → %i sheets (%i full, last %i)', (q, sheets, full, last) => {
    expect(planSheets(q, 48)).toEqual({
      units: q,
      unitsPerSheet: 48,
      sheets,
      fullSheets: full,
      lastSheetUnits: last,
    });
  });

  it('placement is row-major from the top-left, units tile the sheet without overlap', () => {
    expect(placeUnit(0, DEFAULT_PRINT_LAYOUT)).toMatchObject({
      sheet: 1,
      row: 1,
      column: 1,
      xPt: 0,
      yPt: 0,
    });
    expect(placeUnit(3, DEFAULT_PRINT_LAYOUT)).toMatchObject({
      row: 1,
      column: 4,
      xPt: 972,
      yPt: 0,
    });
    expect(placeUnit(47, DEFAULT_PRINT_LAYOUT)).toMatchObject({
      sheet: 1,
      row: 12,
      column: 4,
      xPt: 972,
      yPt: 792,
    });
    expect(placeUnit(48, DEFAULT_PRINT_LAYOUT)).toMatchObject({
      sheet: 2,
      row: 1,
      column: 1,
      position: 1,
    });
    const boxes = Array.from({ length: 48 }, (_, i) => {
      const p = placeUnit(i, DEFAULT_PRINT_LAYOUT);
      return { x: p.xPt, y: p.yPt, w: UNIT_W, h: UNIT_H };
    });
    for (let a = 0; a < 48; a++)
      for (let b = a + 1; b < 48; b++) expect(boxesOverlap(boxes[a]!, boxes[b]!)).toBe(false);
    const last = boxes[47]!;
    expect(last.x + last.w).toBe(1296);
    expect(last.y + last.h).toBe(864);
  });

  it('rejects impossible layouts instead of scaling labels', () => {
    const bad = (patch: Partial<PrintSheetLayout>) =>
      validatePrintLayout({ ...DEFAULT_PRINT_LAYOUT, ...patch });
    expect(bad({ outerMarginXIn: 0.1 })[0]!.message).toMatch(/columns need 18.2 in/);
    expect(bad({ gutterYIn: 0.05 })[0]!.message).toMatch(/rows need 12.55 in/);
    expect(bad({ unitWidthIn: 4.4 })[0]!.message).toMatch(/never scaled/);
    expect(bad({ unitHeightIn: 1.1 })[0]!.field).toBe('unitHeightIn');
    expect(bad({ bleedMm: 1 })[0]!.field).toBe('bleedMm');
    expect(bad({ columns: 3.5 })[0]!.field).toBe('columns');
    // A vendor layout with margins and gutters on a bigger sheet is fine.
    expect(
      bad({
        sheetWidthIn: 19,
        sheetHeightIn: 14,
        outerMarginXIn: 0.25,
        outerMarginYIn: 0.25,
        gutterXIn: 0.125,
        gutterYIn: 0.125,
        bleedMm: 1.5,
      }),
    ).toEqual([]);
  });
});

describe('cut plan', () => {
  it('shared cut lines appear once: 13 horizontal + 5 vertical through-cuts for 48-up', () => {
    const plan = planCuts(DEFAULT_PRINT_LAYOUT, geometry);
    const horizontal = plan.through.filter((s) => s.y1 === s.y2);
    const vertical = plan.through.filter((s) => s.x1 === s.x2);
    expect(horizontal).toHaveLength(13);
    expect(vertical).toHaveLength(5);
    expect(horizontal.every((s) => s.x1 === 0 && s.x2 === 1296)).toBe(true);
    expect(plan.kissCover).toHaveLength(48);
    expect(plan.kissBase).toHaveLength(48);
  });
});

describe('production PDF', () => {
  const pageSizes = (pdf: string) =>
    [...pdf.matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((m) => m[1]!.trim());

  it.each([1, 4, 47, 48, 49, 96, 100])(
    '%i units: exact 1296 × 864 pt pages, one PIN per unit, blanks stay blank',
    async (count) => {
      const pdf = await pdfBuffer(count);
      const plan = planSheets(count, 48);
      expect(pageSizes(pdf)).toEqual(Array(plan.sheets).fill('0 0 1296 864'));
      const pins = shownText(pdf).filter((t) => t.startsWith('PIN: '));
      expect(pins).toEqual(Array.from({ length: count }, (_, i) => `PIN: ${unit(i).pin}`));
      expect(shownText(pdf).filter((t) => t === 'REMOVE')).toHaveLength(count);
      // Exact OZZO red as an RGB fill operator.
      expect(pdf).toMatch(/0\.92549\d* 0\.10980\d* 0\.13333\d* (rg|scn)/);
    },
  );

  it('1000 and 5000 units stream as 21 and 105 sheets', async () => {
    for (const [count, sheets] of [
      [1000, 21],
      [5000, 105],
    ] as const) {
      const pdf = await pdfBuffer(count);
      expect(pageSizes(pdf)).toHaveLength(sheets);
      expect(shownText(pdf).filter((t) => t.startsWith('PIN: '))).toHaveLength(count);
    }
  }, 120_000);

  it('cut guide is one sheet with ThroughCut and CutContour spot colours', async () => {
    const doc = cutGuidePdf(DEFAULT_PRINT_LAYOUT, geometry, 'cut', false);
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise((r) => doc.on('end', r));
    doc.end();
    await done;
    const pdf = Buffer.concat(chunks).toString('latin1');
    expect(pageSizes(pdf)).toEqual(['0 0 1296 864']);
    expect(pdf).toContain('/ThroughCut');
    expect(pdf).toContain('/CutContour');
    expect(shownText(pdf)).toEqual([]);
  });
});

describe('design constants', () => {
  it('cover overlap and cut tolerance are the documented values', () => {
    expect(STICKER_DESIGN.coverOverlapMm).toBe(1.5);
    expect(STICKER_DESIGN.cutToleranceMm).toBe(0.5);
    expect(STICKER_DESIGN.qr.errorCorrection).toBe('Q');
  });

  it('every display element has a role (QA traceability)', () => {
    const els: DrawElement[] = layoutUnit(unit(2), ctx);
    expect(els.every((e) => e.role.length > 0)).toBe(true);
  });
});
