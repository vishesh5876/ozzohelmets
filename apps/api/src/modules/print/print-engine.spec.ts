import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import jsQR from 'jsqr';
import sharp from 'sharp';
import {
  CUTTER_PRINT_PRESET,
  DEFAULT_PRINT_LAYOUT,
  DEFAULT_PRINT_PRESET,
  FULL_SHEET_WARNING,
  mmToPt,
  needsFullSheetWarning,
  parseStudioDocument,
  placeUnit,
  planSheets,
  presetOf,
  PRINT_PRESETS,
  type PrintSheetLayout,
  unitsPerSheet,
  validatePrintLayout,
} from '@helmet/types';
import type { ArtworkAsset } from './artwork';
import { planCuts } from './cut-lines';
import { LogoAssetError, OZZO_RED, parseLogoSvg } from './logo-asset';
import { createTextMetrics, cutGuidePdf, SheetPdf } from './pdf-renderer';
import { PRINTER_EDGE_MM, registrationMarks, sheetMarks } from './sheet-marks';
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

describe('own printer + cutter: bleed, gaps and sheet marks', () => {
  const CUTTER = PRINT_PRESETS[CUTTER_PRINT_PRESET]!;
  const art: ArtworkAsset = {
    key: 'k',
    format: 'SVG',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 450 100"><rect width="450" height="100" fill="#1d3557"/></svg>',
    viewBox: { x: 0, y: 0, width: 450, height: 100 },
  };
  const bleed = mmToPt(CUTTER.bleedMm);
  const artCtx = (scalePercent = 100, b = bleed) => ({
    ...ctx,
    bleed: b,
    artwork: { base: art, cover: null, position: { scalePercent, offsetXMm: 0, offsetYMm: 0 } },
  });
  const pieces = (els: DrawElement[]) =>
    els.filter((e): e is Extract<DrawElement, { kind: 'artwork' }> => e.kind === 'artwork');
  const baseRight = geometry.zones.credential.x + 1;

  it('is a valid 3 × 10 = 30-up layout with room for bleed between every unit', () => {
    expect(validatePrintLayout(CUTTER)).toEqual([]);
    expect(unitsPerSheet(CUTTER)).toBe(30);
    expect(needsFullSheetWarning(CUTTER)).toBe(false);
    expect(mmToPt(CUTTER.bleedMm) * 2).toBeLessThanOrEqual(CUTTER.gutterXIn * 72 + 1e-9);
    expect(presetOf(CUTTER)).toBe(CUTTER_PRINT_PRESET);
    expect(presetOf(DEFAULT_PRINT_LAYOUT)).toBe(DEFAULT_PRINT_PRESET);
    // Units sit inside the sheet with printer-safe margins on every side.
    const last = placeUnit(29, CUTTER);
    expect(last.xPt + UNIT_W).toBeLessThanOrEqual(18 * 72 - 0.5 * 72);
    expect(last.yPt + UNIT_H).toBeLessThanOrEqual(12 * 72 - 0.5 * 72);
  });

  it('extends artwork that reaches a trim edge past it by mirroring, never by stretching', () => {
    const els = layoutUnit(unit(1), artCtx());
    const p = pieces(els);
    const main = p.find((e) => e.role === 'artwork-base')!;
    expect(main.clip).toEqual({
      x: -bleed,
      y: -bleed,
      w: baseRight + bleed,
      h: UNIT_H + 2 * bleed,
    });
    // Left, top, bottom strips and the two left corners; nothing towards the cover zone.
    const mirrors = p.filter((e) => e.role === 'artwork-bleed');
    expect(mirrors).toHaveLength(5);
    for (const m of [main, ...mirrors]) {
      expect(m.w / m.h).toBeCloseTo(4.5, 10);
      expect(m.w).toBeCloseTo(main.w, 10);
      expect(m.clip.x + m.clip.w).toBeLessThanOrEqual(baseRight + 1e-9);
    }
    const left = mirrors.find((m) => m.flipX && !m.flipY)!;
    expect(left.x + left.w).toBeCloseTo(main.x, 10); // reflected about the artwork's edge
    expect(left.clip).toMatchObject({ x: -bleed, w: bleed + 0.5 }); // reaches 0.5 pt under the art
    // Mirrors first, artwork last: its own edge covers each join.
    expect(p[p.length - 1]).toBe(main);
    const top = mirrors.find((m) => m.flipY && !m.flipX && m.y < 0)!;
    expect(top.y + top.h).toBeCloseTo(main.y, 10);
    const under = mirrors.find((m) => m.flipY && !m.flipX && m.y > 0)!;
    expect(under.y).toBeCloseTo(main.y + main.h, 10);
    // The white credential panel runs through the bleed so no artwork shows above/below it.
    const panel = els.find((e) => e.role === 'credential-panel')!;
    expect(elementBounds(panel)).toMatchObject({ y: -bleed, h: UNIT_H + 2 * bleed });
  });

  it('no mirrors when the artwork does not reach the edge, or when there is no bleed', () => {
    expect(
      pieces(layoutUnit(unit(1), artCtx(80))).filter((e) => e.role === 'artwork-bleed'),
    ).toEqual([]);
    const flat = pieces(layoutUnit(unit(1), artCtx(100, 0)));
    expect(flat).toHaveLength(1);
    // Confined to the emergency zone (+1 pt under the white panel); never the weeded cover zone.
    expect(flat[0]!.clip).toEqual({ x: 0, y: 0, w: baseRight, h: UNIT_H });
  });

  it('bleed stays within half the gap: it never reaches a neighbouring unit', () => {
    for (const el of layoutUnit(unit(1), artCtx())) {
      const b = elementBounds(el);
      expect(b.x).toBeGreaterThanOrEqual(-bleed - 1e-9);
      expect(b.y).toBeGreaterThanOrEqual(-bleed - 1e-9);
      expect(b.y + b.h).toBeLessThanOrEqual(UNIT_H + bleed + 1e-9);
    }
    expect(bleed).toBeLessThanOrEqual((CUTTER.gutterYIn * 72) / 2 + 1e-9);
  });

  it('registration marks and a 100 mm scale bar sit in the margins, clear of every unit', () => {
    const marks = sheetMarks(CUTTER, metrics);
    const squares = marks.filter((m) => m.role === 'registration-mark').map(elementBounds);
    expect(squares).toEqual(registrationMarks(CUTTER));
    expect(squares).toHaveLength(4);
    const edge = mmToPt(PRINTER_EDGE_MM);
    const units = Array.from({ length: 30 }, (_, i) => {
      const p = placeUnit(i, CUTTER);
      return { x: p.xPt - bleed, y: p.yPt - bleed, w: UNIT_W + 2 * bleed, h: UNIT_H + 2 * bleed };
    });
    for (const el of marks) {
      const b = elementBounds(el);
      expect(b.x).toBeGreaterThanOrEqual(edge);
      expect(b.x + b.w).toBeLessThanOrEqual(18 * 72 - edge);
      for (const u of units) expect(boxesOverlap(b, u)).toBe(false);
    }
    for (const s of squares) expect(mm(s.w)).toBeCloseTo(5, 6);
    const bar = marks.filter((m) => m.role === 'scale-bar').map(elementBounds);
    expect(mm(Math.max(...bar.map((b) => b.h)))).toBeCloseTo(100, 6);
    // The edge-to-edge print-shop sheet has no margin, so no marks.
    expect(sheetMarks(DEFAULT_PRINT_LAYOUT, metrics)).toEqual([]);
  });

  it('PDF: marks on every sheet, viewers told to print at 100 %, artwork mirrored with a 1:1 flip', async () => {
    const pdf = new SheetPdf({ layout: CUTTER, fonts, title: 't', compress: false });
    const chunks: Buffer[] = [];
    pdf.doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise((r) => pdf.doc.on('end', r));
    const c = artCtx();
    for (let i = 0; i < 31; i++) pdf.addUnit(i, layoutUnit(unit(i), c));
    pdf.end();
    await done;
    const out = Buffer.concat(chunks).toString('latin1');
    expect(out).toMatch(/\/PrintScaling \/None/);
    expect([...out.matchAll(/\/MediaBox \[([^\]]+)\]/g)]).toHaveLength(2);
    const labels = shownText(out).filter((t) => t.includes('THIS BAR MUST MEASURE 100 mm'));
    expect(labels).toHaveLength(2);
    expect(out).toMatch(/\n-1 0 0 1 [\d.]+ [\d.]+ cm/); // horizontal mirror, magnitude 1
  });

  it('2.2 : 1 panel artwork fills exactly the emergency panel and never reaches the Safety ID', () => {
    const panel: ArtworkAsset = {
      ...art,
      key: 'p',
      viewBox: { x: 0, y: 0, width: 220, height: 100 },
    };
    const els = layoutUnit(unit(1), {
      ...ctx,
      bleed,
      artwork: {
        base: panel,
        cover: null,
        position: { scalePercent: 100, offsetXMm: 0, offsetYMm: 0 },
      },
    });
    const main = pieces(els).find((e) => e.role === 'artwork-base')!;
    expect({ x: main.x, y: main.y, w: main.w, h: main.h }).toEqual(geometry.zones.emergency);
    const id = elementBounds(els.find((e) => e.role === 'safety-code')!);
    for (const p of pieces(els)) {
      const b = elementBounds(p);
      expect(b.x + b.w).toBeLessThanOrEqual(geometry.zones.credential.x + 1 + 1e-9);
      expect(boxesOverlap(b, id)).toBe(false);
    }
  });

  it('design on top: artwork over the white panel, QR / PIN / Safety ID kept clear above it', () => {
    const els = layoutUnit(unit(1), {
      ...ctx,
      bleed: 0,
      artwork: {
        base: art,
        cover: null,
        position: { scalePercent: 100, offsetXMm: 0, offsetYMm: 0 },
        onTop: true,
      },
    });
    const idx = (role: string) => els.findIndex((e) => e.role === role);
    const lastIdx = (role: string) => els.map((e) => e.role).lastIndexOf(role);
    // Order: white panel → artwork → keep-clear boxes → ID / PIN / QR.
    expect(idx('credential-panel')).toBeLessThan(idx('artwork-base'));
    expect(lastIdx('artwork-base')).toBeLessThan(idx('keep-clear'));
    expect(lastIdx('keep-clear')).toBeLessThan(idx('safety-code'));
    expect(lastIdx('keep-clear')).toBeLessThan(idx('qr'));
    // Artwork reaches the base | cover kiss cut (not cut at the emergency zone), never the cover.
    const main = pieces(els).find((e) => e.role === 'artwork-base')!;
    expect(main.clip.x + main.clip.w).toBeCloseTo(
      geometry.zones.credential.x + geometry.zones.credential.w,
      10,
    );
    // Keep-clear boxes contain the whole protected target and the whole Safety ID text.
    const clear = els.filter((e) => e.role === 'keep-clear').map(elementBounds);
    const inside = (a: { x: number; y: number; w: number; h: number }) =>
      clear.some(
        (c) => a.x >= c.x && a.y >= c.y && a.x + a.w <= c.x + c.w && a.y + a.h <= c.y + c.h,
      );
    expect(inside(geometry.target)).toBe(true);
    expect(inside(elementBounds(els.find((e) => e.role === 'safety-code')!))).toBe(true);
    expect(inside(elementBounds(els.find((e) => e.role === 'pin')!))).toBe(true);
    // Legacy layering keeps artwork under the panel.
    const legacy = layoutUnit(unit(1), {
      ...ctx,
      artwork: {
        base: art,
        cover: null,
        position: { scalePercent: 100, offsetXMm: 0, offsetYMm: 0 },
      },
    });
    expect(legacy.findIndex((e) => e.role === 'artwork-base')).toBeLessThan(
      legacy.findIndex((e) => e.role === 'credential-panel'),
    );
    expect(legacy.some((e) => e.role === 'keep-clear')).toBe(false);
  });

  it('SVG preview mirrors the same way', () => {
    const svg = unitSvg(layoutUnit(unit(1), artCtx()));
    expect(svg).toContain('scale(-1 1)');
    expect(svg).toContain('scale(1 -1)');
    expect(svg).toContain('scale(-1 -1)');
  });
});

describe('Print Studio layers', () => {
  const png: ArtworkAsset = {
    key: 'studio-png',
    format: 'PNG',
    png: Buffer.alloc(0),
    widthPx: 1200,
    heightPx: 400,
  };
  const layer = (o: Record<string, unknown>) => ({
    id: `l${Math.random().toString(36).slice(2, 8)}`,
    name: 'layer',
    part: 'sticker',
    x: 10,
    y: 10,
    w: 60,
    h: 20,
    rotate: 0,
    hidden: false,
    locked: false,
    ...o,
  });
  const doc = (layers: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    parseStudioDocument({
      version: 1,
      stickerBackground: '#121212',
      coverBackground: '#FFE300',
      defaultCover: false,
      layers,
      ...extra,
    });
  const studioCtx = (d: ReturnType<typeof doc>) => ({
    ...ctx,
    studio: { document: d, images: new Map([['0190f0a0-0000-7000-8000-000000000001', png]]) },
  });

  it('draws background → layers → keep-clear → ID / PIN / QR, QR always last on the sticker', () => {
    const els = layoutUnit(
      unit(1),
      studioCtx(
        doc([
          layer({ kind: 'rect', fill: '#EC1C22', x: 0, y: 0, w: 324, h: 72, part: 'both' }),
          layer({ kind: 'text', text: 'IN AN\nEMERGENCY', sizePt: 10, color: '#FFFFFF' }),
        ]),
      ),
    );
    const at = (role: string) => els.findIndex((e) => e.role === role);
    expect(at('studio-background')).toBeLessThan(at('studio-sticker'));
    expect(at('studio-sticker')).toBeLessThan(at('keep-clear'));
    expect(at('keep-clear')).toBeLessThan(at('qr'));
    expect(at('qr')).toBeLessThan(at('studio-cover'));
    // Sticker layers are clipped at the base | cover kiss cut; cover layers to the cover box.
    const sticker = els[at('studio-sticker')] as Extract<DrawElement, { kind: 'group' }>;
    expect(sticker.clip!.x + sticker.clip!.w).toBeCloseTo(geometry.zones.cover.x);
    const cover = els[at('studio-cover')] as Extract<DrawElement, { kind: 'group' }>;
    expect(cover.clip).toEqual(geometry.coverYellow);
    // A 'both' layer prints on each piece; two text lines = two text elements.
    expect(sticker.children.filter((e) => e.kind === 'text')).toHaveLength(2);
    expect(cover.children.some((e) => e.kind === 'rect')).toBe(true);
  });

  it('keeps the default yellow cover when chosen (cover layers ignored)', () => {
    const els = layoutUnit(
      unit(1),
      studioCtx(
        doc([layer({ kind: 'rect', fill: '#000000', part: 'cover', x: 250 })], {
          defaultCover: true,
        }),
      ),
    );
    expect(els.some((e) => e.role === 'cover')).toBe(true);
    expect(els.some((e) => e.role === 'studio-cover')).toBe(false);
  });

  it('images keep their aspect ratio (contain / cover), rotated layers are grouped', () => {
    const id = '0190f0a0-0000-7000-8000-000000000001';
    const els = layoutUnit(
      unit(1),
      studioCtx(
        doc([
          layer({ kind: 'image', fileId: id, fit: 'contain', w: 60, h: 40 }),
          layer({ kind: 'image', fileId: id, fit: 'cover', w: 60, h: 40, rotate: 30 }),
        ]),
      ),
    );
    const g = els.find((e) => e.role === 'studio-sticker') as Extract<
      DrawElement,
      { kind: 'group' }
    >;
    const [contain, rotated] = g.children;
    const c = contain as Extract<DrawElement, { kind: 'artwork' }>;
    expect(c.w / c.h).toBeCloseTo(3);
    expect(c.w).toBeCloseTo(60);
    const r = rotated as Extract<DrawElement, { kind: 'group' }>;
    expect(r.rotate).toEqual({ deg: 30, cx: 40, cy: 30 });
    const s = r.children[0] as Extract<DrawElement, { kind: 'artwork' }>;
    expect(s.w / s.h).toBeCloseTo(3);
    expect(s.h).toBeCloseTo(40);
    expect(s.clip).toEqual({ x: 10, y: 10, w: 60, h: 40 });
  });

  it('a missing image is a layout error, never a silent blank', () => {
    expect(() =>
      layoutUnit(unit(1), {
        ...ctx,
        studio: {
          document: doc([layer({ kind: 'image', fileId: '0190f0a0-0000-7000-8000-000000000009' })]),
          images: new Map(),
        },
      }),
    ).toThrow(/not available/);
  });

  it('renders to PDF and SVG, and the QR still decodes over a full-bleed design', async () => {
    const d = doc([
      layer({ kind: 'rect', fill: '#000000', x: -5, y: -5, w: 340, h: 82, part: 'both' }),
      layer({
        kind: 'ellipse',
        fill: '#EC1C22',
        stroke: '#FFFFFF',
        strokePt: 1,
        x: 150,
        y: 0,
        w: 100,
        h: 72,
      }),
      layer({ kind: 'arrow', color: '#FFFFFF', x: 120, y: 30, w: 30, h: 10, rotate: 90 }),
      layer({
        kind: 'text',
        text: 'RIGHT',
        align: 'right',
        sizePt: 8,
        color: '#FFFFFF',
        x: 0,
        w: 150,
      }),
    ]);
    const els = layoutUnit(unit(2), studioCtx(d));
    const svg = unitSvg(els);
    expect(svg).toContain('<ellipse');
    expect(svg).toContain('rotate(90 135 35)');
    const { data, info } = await sharp(Buffer.from(svg), { density: 600 })
      .flatten({ background: '#fff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toBe(
      unit(2).qrPayload,
    );
    const pdf = new SheetPdf({ layout: DEFAULT_PRINT_LAYOUT, fonts, title: 't', compress: false });
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
    pdf.addUnit(0, els);
    pdf.end();
    await done;
    const out = Buffer.concat(chunks).toString('latin1');
    expect(out.startsWith('%PDF')).toBe(true);
    // Live vector text (not an image) and a clip for the sticker piece.
    expect(out).toMatch(/\] TJ/);
    expect(out).toMatch(/W n/);
  }, 60_000);
});
