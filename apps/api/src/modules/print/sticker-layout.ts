import { mmToPt } from '@helmet/types';
import * as QRCode from 'qrcode';
import {
  type ArtworkAsset,
  type ArtworkPosition,
  placeBaseArtwork,
  placeCoverArtwork,
  artworkAspect,
} from './artwork';
import type { LogoAsset } from './logo-asset';
import {
  COVER_OVERLAP,
  CUT_TOL,
  DEFAULT_COVER_YELLOW,
  STICKER_DESIGN as D,
  UNIT_H,
  UNIT_W,
} from './sticker-design';

/**
 * Deterministic physical layout of ONE Safety ID unit, in PDF points from the unit's top-left
 * (y grows downwards). Produces a renderer-neutral display list drawn identically by the PDF
 * engine and the SVG preview. Positions never depend on any web/responsive layout.
 */

export type Weight = 'regular' | 'bold';

/** Font metrics of the fonts the renderer will actually use (pdfkit AFM or embedded TTF). */
export interface TextMetrics {
  width(text: string, weight: Weight, size: number, characterSpacing?: number): number;
  /** Cap height per 1 pt of font size. */
  capHeight(weight: Weight): number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface QrMatrix {
  /** Modules per side (without quiet zone). */
  size: number;
  version: number;
  /** Row-major, 1 = dark. */
  data: Uint8Array;
}

export type DrawElement =
  | {
      kind: 'rect';
      role: string;
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: string;
      stroke?: string;
      lineWidth?: number;
      radius?: number;
      dash?: number;
    }
  | { kind: 'polygon'; role: string; points: [number, number][]; fill: string }
  | {
      kind: 'text';
      role: string;
      text: string;
      /** Left of the baseline ('start') or its centre ('middle'); rotation origin. */
      x: number;
      y: number;
      anchor: 'start' | 'middle';
      rotate: 0 | -90;
      weight: Weight;
      size: number;
      fill: string;
      characterSpacing: number;
      /** Measured advance width (renderers must reproduce it exactly). */
      width: number;
      capHeight: number;
    }
  | { kind: 'logo'; role: string; x: number; y: number; scale: number; logo: LogoAsset }
  | { kind: 'logo-placeholder'; role: string; x: number; y: number; w: number; h: number }
  | {
      /** Admin artwork drawn into (x, y, w, h) — always the artwork's own aspect ratio — and
       *  clipped to `clip`. SVG stays vector; PNG is embedded losslessly. */
      kind: 'artwork';
      role: string;
      artwork: ArtworkAsset;
      x: number;
      y: number;
      w: number;
      h: number;
      clip: Box;
      /** Mirrored inside its own box (bleed extension only): still a uniform 1:1 scale. */
      flipX?: boolean;
      flipY?: boolean;
    }
  | {
      kind: 'qr';
      role: string;
      x: number;
      y: number;
      /** Symbol + quiet zone, square. */
      size: number;
      matrix: QrMatrix;
      quietZoneModules: number;
    };

export interface StickerGeometry {
  safeInset: number;
  zones: { emergency: Box; credential: Box; cover: Box };
  /** Baseline x of the rotated Safety ID (glyphs extend leftwards by the cap height). */
  idBaselineX: number;
  /** Protected credential target: PIN + QR + quiet zone. */
  target: Box;
  /** QR symbol + quiet zone (square, inside the target). */
  qrBox: Box;
  pinBaselineY: number;
  /** Where the applied cover sits on the base sticker: target + overlap on every side. */
  coverFootprint: Box;
  /** The cover's die line inside the cover zone (same size as the footprint). */
  coverDie: Box;
  coverYellow: Box;
}

export interface UnitData {
  safetyCode: string;
  /** Plaintext PIN for this unit only (never logged). */
  pin: string;
  /** The exact QR content: the Safety ID's public URL. */
  qrPayload: string;
}

export class StickerLayoutError extends Error {}

const expand = (b: Box, by: number): Box => ({
  x: b.x - by,
  y: b.y - by,
  w: b.w + 2 * by,
  h: b.h + 2 * by,
});

/** Derives every physical size from STICKER_DESIGN and the safe area; validates the result. */
export function computeStickerGeometry(safeAreaMm: number, metrics: TextMetrics): StickerGeometry {
  const safe = mmToPt(safeAreaMm);
  const ex = D.zones.emergencyIn * 72;
  const cw = D.zones.credentialIn * 72;
  const vw = D.zones.coverIn * 72;
  if (Math.abs(ex + cw + vw - UNIT_W) > 1e-6)
    throw new StickerLayoutError('Zone widths must add up to the 4.5 in unit.');
  const zones = {
    emergency: { x: 0, y: 0, w: ex, h: UNIT_H },
    credential: { x: ex, y: 0, w: cw, h: UNIT_H },
    cover: { x: ex + cw, y: 0, w: vw, h: UNIT_H },
  };

  const idBaselineX = ex + D.id.insetFromZonePt + metrics.capHeight('bold') * D.id.fontPt;
  const footLeft = idBaselineX + D.id.gapToCoverPt;
  const footRight = ex + cw - CUT_TOL;
  // Applied cover never overhangs the base sticker: target + overlap stays CUT_TOL inside it.
  const edge = CUT_TOL + COVER_OVERLAP;
  const targetTop = Math.max(edge, safe);
  const targetBottomLimit = UNIT_H - edge;
  const pinBaselineY = targetTop + metrics.capHeight('bold') * D.pin.fontPt;
  const qrTop = pinBaselineY + D.pin.gapToQrPt;
  const maxTargetW = footRight - footLeft - 2 * COVER_OVERLAP;
  // QR as large as the geometry allows (scan reliability first).
  const qrSize = Math.min(targetBottomLimit - qrTop, maxTargetW);
  if (qrSize <= 0) throw new StickerLayoutError('No room for the QR code.');
  const targetX = footLeft + COVER_OVERLAP + (maxTargetW - qrSize) / 2;
  const target = { x: targetX, y: targetTop, w: qrSize, h: qrTop + qrSize - targetTop };
  const qrBox = { x: targetX, y: qrTop, w: qrSize, h: qrSize };
  const coverFootprint = expand(target, COVER_OVERLAP);
  const coverDie = {
    x: zones.cover.x + (vw - coverFootprint.w) / 2,
    y: (UNIT_H - coverFootprint.h) / 2,
    w: coverFootprint.w,
    h: coverFootprint.h,
  };
  const bleed = mmToPt(D.coverPrintBleedMm);
  const yx0 = Math.max(zones.cover.x, coverDie.x - bleed);
  const yy0 = Math.max(0, coverDie.y - bleed);
  const coverYellow = {
    x: yx0,
    y: yy0,
    w: Math.min(UNIT_W, coverDie.x + coverDie.w + bleed) - yx0,
    h: Math.min(UNIT_H, coverDie.y + coverDie.h + bleed) - yy0,
  };
  const g: StickerGeometry = {
    safeInset: safe,
    zones,
    idBaselineX,
    target,
    qrBox,
    pinBaselineY,
    coverFootprint,
    coverDie,
    coverYellow,
  };
  const issues = geometryIssues(g);
  if (issues.length) throw new StickerLayoutError(issues.join(' '));
  return g;
}

const EPS = 1e-6;
const inside = (inner: Box, outer: Box, margin = 0) =>
  inner.x >= outer.x + margin - EPS &&
  inner.y >= outer.y + margin - EPS &&
  inner.x + inner.w <= outer.x + outer.w - margin + EPS &&
  inner.y + inner.h <= outer.y + outer.h - margin + EPS;

/** The physical rules the cover/target design must satisfy (also asserted by unit tests). */
export function geometryIssues(g: StickerGeometry): string[] {
  const issues: string[] = [];
  const cred = g.zones.credential;
  const base = { x: 0, y: 0, w: cred.x + cred.w, h: UNIT_H };
  if (!inside(g.qrBox, g.target)) issues.push('QR box must be inside the protected target.');
  if (!inside(expand(g.target, COVER_OVERLAP - EPS), g.coverFootprint))
    issues.push('Cover must exceed the target by the overlap on every side.');
  if (
    Math.abs(g.coverDie.w - g.coverFootprint.w) > EPS ||
    Math.abs(g.coverDie.h - g.coverFootprint.h) > EPS
  )
    issues.push('Cover die size must equal the cover footprint.');
  if (!inside(g.coverDie, g.zones.cover, CUT_TOL))
    issues.push('Cover die must stay inside the cover zone, clear of every cut line.');
  if (!inside(g.coverFootprint, base, CUT_TOL))
    issues.push('Applied cover must not overhang the base sticker.');
  if (g.coverFootprint.x < cred.x - EPS)
    issues.push('Applied cover must not overlap the emergency panel.');
  if (g.coverFootprint.x < g.idBaselineX - EPS)
    issues.push('Applied cover must leave the Safety ID visible.');
  if (!inside(g.coverYellow, g.zones.cover)) issues.push('Cover ink must stay in the cover zone.');
  if (g.target.y < g.safeInset - EPS) issues.push('PIN must respect the safe area.');
  return issues;
}

/** QR modules for the exact payload (error correction from STICKER_DESIGN). */
export function qrMatrix(payload: string): QrMatrix {
  const qr = QRCode.create(payload, { errorCorrectionLevel: D.qr.errorCorrection });
  return {
    size: qr.modules.size,
    version: qr.version,
    data: Uint8Array.from(qr.modules.data as ArrayLike<number>),
  };
}

export interface LayoutContext {
  geometry: StickerGeometry;
  metrics: TextMetrics;
  logo: LogoAsset | null;
  yellow?: string;
  /** Adds QA-only outlines (target, cover footprint, cover die). Never in production files. */
  proof?: boolean;
  /** Admin preview "Show Guides" (same outlines as proof, plus safe area and dynamic areas). */
  guides?: boolean;
  /** Print Design artwork. Without it the built-in (legacy) emergency panel is drawn. */
  artwork?: {
    base: ArtworkAsset;
    cover: ArtworkAsset | null;
    position: ArtworkPosition;
  };
  /** Sample-data test print: every unit is visibly marked TEST PRINT. */
  testPrint?: boolean;
  /** Layout bleed (pt): artwork reaching a trim edge continues this far past it. */
  bleed?: number;
}

const EDGE_EPS = 0.01;
/** Overlap of a bleed mirror under the artwork it continues (pt). */
const SEAM = 0.5;

/**
 * Base artwork, confined to the emergency zone (the credential panel is white by rule and the
 * cover zone outside the cover die is weeded waste). With a layout bleed, every trim edge the artwork
 * reaches (left, top, bottom) continues past the cut: by the artwork itself when it already
 * extends that far, otherwise by a mirror image of its own edge — never by stretching. So a cut
 * that drifts by up to the bleed shows design, not a white sliver.
 */
export function baseArtwork(
  art: ArtworkAsset,
  position: ArtworkPosition,
  g: StickerGeometry,
  bleed: number,
): DrawElement[] {
  const box = placeBaseArtwork(artworkAspect(art), position);
  const b = Math.max(0, bleed);
  // Only the emergency zone shows artwork: the white credential panel is drawn over the rest.
  // Stopping 1 pt under the panel (instead of running under all of it) leaves no coincident
  // edges for a RIP to anti-alias into a hairline at the bleed line.
  const right = g.zones.credential.x + 1;
  const piece = (
    role: string,
    x: number,
    y: number,
    clip: Box,
    flip: { flipX?: boolean; flipY?: boolean } = {},
  ): DrawElement => ({
    kind: 'artwork',
    role,
    artwork: art,
    x,
    y,
    w: box.w,
    h: box.h,
    clip,
    ...flip,
  });
  const main = piece('artwork-base', box.x, box.y, {
    x: 0 - b,
    y: 0 - b,
    w: right + b,
    h: UNIT_H + 2 * b,
  });
  if (b <= 0) return [main];

  const bottom = box.y + box.h;
  // How much of the bleed each edge's mirror must fill: > 0 only when the artwork reaches that
  // trim edge but stops short of the bleed line.
  const left = box.x <= EDGE_EPS ? Math.max(0, box.x + b) : 0;
  const top = box.y <= EDGE_EPS ? Math.max(0, box.y + b) : 0;
  const under = bottom >= UNIT_H - EDGE_EPS ? Math.max(0, UNIT_H + b - bottom) : 0;
  // Spans of the artwork inside the bleed box, for the strips along each edge.
  const x0 = Math.max(box.x, -b);
  const x1 = Math.min(box.x + box.w, right);
  const y0 = Math.max(box.y, -b);
  const y1 = Math.min(bottom, UNIT_H + b);
  // Each mirror is reflected about the artwork's own edge, so it continues it seamlessly. It
  // reaches SEAM under the artwork and is drawn first: the artwork's own edge then covers the
  // join, so no anti-aliased hairline can appear on the cut line.
  const mx = box.x - box.w;
  const myTop = box.y - box.h;
  const S = SEAM;
  const mirrors: DrawElement[] = [];
  if (left > 0)
    mirrors.push(
      piece('artwork-bleed', mx, box.y, { x: -b, y: y0, w: left + S, h: y1 - y0 }, { flipX: true }),
    );
  if (top > 0)
    mirrors.push(
      piece(
        'artwork-bleed',
        box.x,
        myTop,
        { x: x0, y: -b, w: x1 - x0, h: top + S },
        { flipY: true },
      ),
    );
  if (under > 0)
    mirrors.push(
      piece(
        'artwork-bleed',
        box.x,
        bottom,
        { x: x0, y: bottom - S, w: x1 - x0, h: under + S },
        { flipY: true },
      ),
    );
  if (left > 0 && top > 0)
    mirrors.push(
      piece(
        'artwork-bleed',
        mx,
        myTop,
        { x: -b, y: -b, w: left + S, h: top + S },
        { flipX: true, flipY: true },
      ),
    );
  if (left > 0 && under > 0)
    mirrors.push(
      piece(
        'artwork-bleed',
        mx,
        bottom,
        { x: -b, y: bottom - S, w: left + S, h: under + S },
        { flipX: true, flipY: true },
      ),
    );
  return [...mirrors, main];
}

/** Minimum printed QR module (Safety ID scans must work from a phone at arm's length). */
export const MIN_QR_MODULE_MM = 0.33;
export const MIN_PIN_FONT_PT = 5;

/** Display list for one unit. Throws StickerLayoutError when the data can't be laid out. */
export function layoutUnit(data: UnitData, ctx: LayoutContext): DrawElement[] {
  const { geometry: g, metrics: m } = ctx;
  const { black, red, white } = D.colors;
  const yellow = ctx.yellow ?? DEFAULT_COVER_YELLOW;
  const out: DrawElement[] = [];
  const safe = g.safeInset;
  const text = (
    role: string,
    value: string,
    x: number,
    y: number,
    weight: Weight,
    size: number,
    fill: string,
    opts: { anchor?: 'start' | 'middle'; rotate?: 0 | -90; characterSpacing?: number } = {},
  ) => {
    const characterSpacing = opts.characterSpacing ?? 0;
    const el: DrawElement = {
      kind: 'text',
      role,
      text: value,
      x,
      y,
      anchor: opts.anchor ?? 'start',
      rotate: opts.rotate ?? 0,
      weight,
      size,
      fill,
      characterSpacing,
      width: m.width(value, weight, size, characterSpacing),
      capHeight: m.capHeight(weight) * size,
    };
    out.push(el);
    return el;
  };
  const cap = (weight: Weight, size: number) => m.capHeight(weight) * size;

  if (ctx.artwork) {
    // ── Admin artwork (Print Design) ─────────────────────────────────────────────────────────
    out.push(...baseArtwork(ctx.artwork.base, ctx.artwork.position, g, ctx.bleed ?? 0));
    // System-controlled white credential panel: no artwork colour or texture behind the ID,
    // PIN, QR or its quiet zone, whatever the design. It runs through the bleed too, so a
    // trim drift never shows artwork above or below it.
    const b = ctx.bleed ?? 0;
    const cred = g.zones.credential;
    out.push({
      kind: 'rect',
      role: 'credential-panel',
      x: cred.x,
      y: 0 - b,
      w: cred.w,
      h: UNIT_H + 2 * b,
      fill: white,
    });
  } else {
    // ── Emergency panel ────────────────────────────────────────────────────────────────────────
    const E = D.emergency;
    const ez = g.zones.emergency;
    const x0 = safe;
    let y = safe;
    if (ctx.logo) {
      const vb = ctx.logo.viewBox;
      const scale = E.logoHeightPt / vb.height; // uniform: never stretched
      out.push({
        kind: 'logo',
        role: 'logo',
        x: x0 - vb.x * scale,
        y: y - vb.y * scale,
        scale,
        logo: ctx.logo,
      });
    } else {
      out.push({
        kind: 'logo-placeholder',
        role: 'logo',
        x: x0,
        y,
        w: E.logoHeightPt * 3.6,
        h: E.logoHeightPt,
      });
    }
    y += E.logoHeightPt + E.gapAfterLogoPt;
    let baseline = y + cap('bold', E.inCaseOfPt);
    text('emergency-heading', 'IN CASE OF', x0, baseline, 'bold', E.inCaseOfPt, black);
    baseline += E.lineGapPt + cap('bold', E.emergencyPt);
    text('emergency-heading', 'EMERGENCY', x0, baseline, 'bold', E.emergencyPt, red);
    baseline += E.gapAfterEmergencyPt + cap('bold', E.medicalPt);
    const medical = text(
      'emergency-medical',
      'FOR MY MEDICAL INFORMATION',
      x0,
      baseline,
      'bold',
      E.medicalPt,
      black,
    );
    const pillTop = UNIT_H - safe - E.pillHeightPt;
    if (medical.y + 1.5 > pillTop) throw new StickerLayoutError('Emergency panel text overflows.');
    const scanW = m.width('SCAN ME', 'bold', E.scanMePt, 0.3);
    const pillW = scanW + 2 * E.pillPaddingXPt;
    out.push({
      kind: 'rect',
      role: 'scan-me-pill',
      x: x0,
      y: pillTop,
      w: pillW,
      h: E.pillHeightPt,
      fill: black,
      radius: E.pillHeightPt / 2,
    });
    const pillMid = pillTop + E.pillHeightPt / 2;
    text(
      'scan-me',
      'SCAN ME',
      x0 + pillW / 2,
      pillMid + cap('bold', E.scanMePt) / 2,
      'bold',
      E.scanMePt,
      white,
      { anchor: 'middle', characterSpacing: 0.3 },
    );
    const tip = ez.x + ez.w - E.arrowEndGapPt;
    const shaftStart = x0 + pillW + E.arrowGapPt;
    const headBase = tip - E.arrowHeadPt;
    if (headBase - shaftStart < 6) throw new StickerLayoutError('No room for the SCAN ME arrow.');
    out.push({
      kind: 'rect',
      role: 'scan-arrow',
      x: shaftStart,
      y: pillMid - E.arrowShaftPt / 2,
      w: headBase - shaftStart + 0.2,
      h: E.arrowShaftPt,
      fill: red,
    });
    out.push({
      kind: 'polygon',
      role: 'scan-arrow',
      points: [
        [tip, pillMid],
        [headBase, pillMid - E.arrowHeadPt / 2],
        [headBase, pillMid + E.arrowHeadPt / 2],
      ],
      fill: red,
    });
    out.push({
      kind: 'rect',
      role: 'divider',
      x: ez.x + ez.w - 0.25,
      y: safe,
      w: 0.5,
      h: UNIT_H - 2 * safe,
      fill: E.dividerColor,
    });
  }

  // ── Credential panel (permanent base sticker) ──────────────────────────────────────────────
  const idText = `ID: ${data.safetyCode}`;
  const idLen = m.width(idText, 'bold', D.id.fontPt);
  if (idLen > UNIT_H - 2 * safe) throw new StickerLayoutError('Safety ID text is too long.');
  text('safety-code', idText, g.idBaselineX, UNIT_H / 2 + idLen / 2, 'bold', D.id.fontPt, black, {
    rotate: -90,
  });
  // Six-digit PINs always print at the design size. A wide legacy 8-symbol PIN (pre-release
  // batch) steps the PIN text down until it fits the QR width — the unit itself never scales.
  const pinText = `PIN: ${data.pin}`;
  let pinSize: number = D.pin.fontPt;
  let pinSpacing: number = D.pin.characterSpacingPt;
  while (m.width(pinText, 'bold', pinSize, pinSpacing) > g.target.w) {
    if (pinSpacing > 0) pinSpacing = 0;
    else if (pinSize > MIN_PIN_FONT_PT) pinSize = Math.max(MIN_PIN_FONT_PT, pinSize - 0.2);
    else throw new StickerLayoutError('PIN text is wider than the QR.');
  }
  text('pin', pinText, g.target.x + g.target.w / 2, g.pinBaselineY, 'bold', pinSize, black, {
    anchor: 'middle',
    characterSpacing: pinSpacing,
  });

  const matrix = qrMatrix(data.qrPayload);
  const moduleMm = (g.qrBox.w / (matrix.size + 2 * D.qr.quietZoneModules)) * (25.4 / 72);
  if (moduleMm < MIN_QR_MODULE_MM)
    throw new StickerLayoutError(
      `QR payload too long: modules would be ${moduleMm.toFixed(3)} mm (minimum ${MIN_QR_MODULE_MM} mm).`,
    );
  // Solid white behind symbol + quiet zone: nothing else may be drawn there.
  out.push({ kind: 'rect', role: 'qr-backing', ...g.qrBox, fill: white });
  out.push({
    kind: 'qr',
    role: 'qr',
    x: g.qrBox.x,
    y: g.qrBox.y,
    size: g.qrBox.w,
    matrix,
    quietZoneModules: D.qr.quietZoneModules,
  });

  // Corner marks just inside the cover footprint: invisible once the cover sits correctly.
  const A = D.alignmentMark;
  const f = g.coverFootprint;
  for (const [cx, cy, sx, sy] of [
    [f.x, f.y, 1, 1],
    [f.x + f.w, f.y, -1, 1],
    [f.x, f.y + f.h, 1, -1],
    [f.x + f.w, f.y + f.h, -1, -1],
  ] as const) {
    const hx = sx > 0 ? cx : cx - A.lengthPt;
    const vy = sy > 0 ? cy : cy - A.lengthPt;
    out.push({
      kind: 'rect',
      role: 'cover-mark',
      x: hx,
      y: sy > 0 ? cy : cy - A.widthPt,
      w: A.lengthPt,
      h: A.widthPt,
      fill: A.color,
    });
    out.push({
      kind: 'rect',
      role: 'cover-mark',
      x: sx > 0 ? cx : cx - A.widthPt,
      y: vy,
      w: A.widthPt,
      h: A.lengthPt,
      fill: A.color,
    });
  }

  if (ctx.artwork?.cover) {
    // ── Custom cover artwork: fills the cover print box (uniform, centred, clipped) ──────────
    const art = ctx.artwork.cover;
    out.push({
      kind: 'artwork',
      role: 'cover-artwork',
      artwork: art,
      ...placeCoverArtwork(artworkAspect(art), g.coverYellow),
      clip: g.coverYellow,
    });
  } else {
    // ── Removable yellow cover (same unit, own die line) ───────────────────────────────────────
    const C = D.cover;
    const die = g.coverDie;
    out.push({ kind: 'rect', role: 'cover', ...g.coverYellow, fill: yellow });
    const tabTop = die.y + die.h - C.tabHeightPt;
    out.push({
      kind: 'rect',
      role: 'cover-tab',
      x: g.coverYellow.x,
      y: tabTop,
      w: g.coverYellow.w,
      h: g.coverYellow.y + g.coverYellow.h - tabTop,
      fill: black,
    });
    const lines: [string, number][] = [
      ['REMOVE', C.removePt],
      ['ONLY IN', C.onlyInPt],
      ['EMERGENCY', C.emergencyPt],
    ];
    const blockH =
      lines.reduce((a, [, s]) => a + cap('bold', s), 0) + C.lineGapPt * (lines.length - 1);
    const areaTop = die.y + safe;
    const areaBottom = tabTop - 2;
    if (blockH > areaBottom - areaTop) throw new StickerLayoutError('Cover text overflows.');
    let ly = areaTop + (areaBottom - areaTop - blockH) / 2;
    const cx = die.x + die.w / 2;
    for (const [value, size] of lines) {
      ly += cap('bold', size);
      const t = text('cover-text', value, cx, ly, 'bold', size, black, { anchor: 'middle' });
      if (t.width > die.w - 2 * safe) throw new StickerLayoutError('Cover text is too wide.');
      ly += C.lineGapPt;
    }
    // "▲ OPEN" tab: a vector triangle (no font glyph dependency) + text, centred in the band.
    const openW = m.width('OPEN', 'bold', C.openPt, 0.4);
    const tri = cap('bold', C.openPt) * 1.15;
    const groupW = tri + 2 + openW;
    const gx = cx - groupW / 2;
    const tabMid = tabTop + (die.y + die.h - tabTop) / 2;
    const openBase = tabMid + cap('bold', C.openPt) / 2;
    out.push({
      kind: 'polygon',
      role: 'cover-open',
      points: [
        [gx + tri / 2, openBase - tri * 0.95],
        [gx, openBase],
        [gx + tri, openBase],
      ],
      fill: yellow,
    });
    text('cover-open', 'OPEN', gx + tri + 2, openBase, 'bold', C.openPt, yellow, {
      characterSpacing: 0.4,
    });
  }

  if (ctx.testPrint) {
    // Clearly marked sample: never mistaken for a real Safety ID.
    const label = 'TEST PRINT';
    const w = m.width(label, 'bold', 6, 0.5) + 6;
    const tx = g.zones.credential.x - w - 3;
    out.push({
      kind: 'rect',
      role: 'test-print',
      x: tx,
      y: safe,
      w,
      h: 9,
      fill: white,
      stroke: red,
      lineWidth: 0.8,
    });
    out.push({ kind: 'rect', role: 'test-print', x: tx, y: safe, w, h: 9, fill: red });
    text('test-print', label, tx + w / 2, safe + 4.5 + cap('bold', 6) / 2, 'bold', 6, white, {
      anchor: 'middle',
      characterSpacing: 0.5,
    });
  }
  if (ctx.proof || ctx.guides) out.push(...guideElements(g, m));
  return out;
}

/** Guide colours (also shown as the admin preview legend). */
export const GUIDE_COLORS = {
  'guide-unit': '#5F6368',
  'guide-artwork-area': '#00897B',
  'guide-safe-area': '#34A853',
  'guide-credential-panel': '#9AA0A6',
  'guide-id-area': '#F29900',
  'guide-target': '#FF00FF',
  'guide-quiet-zone': '#7B1FA2',
  'guide-qr': '#7B1FA2',
  'guide-cover-placement': '#00A0FF',
  'guide-cover-cut': '#00A0FF',
} as const;

/**
 * "Show Guides" / proof overlay: unit boundary, safe area, credential panel, dynamic ID area,
 * protected target, QR + quiet zone, cover placement target and the cover cut. QA only — never
 * part of production artwork.
 */
export function guideElements(g: StickerGeometry, m: TextMetrics): DrawElement[] {
  const s = (
    role: keyof typeof GUIDE_COLORS,
    b: Box,
    dash?: number,
    radius?: number,
  ): DrawElement => ({
    kind: 'rect',
    role,
    ...b,
    stroke: GUIDE_COLORS[role],
    lineWidth: 0.3,
    dash,
    radius,
  });
  const qz = D.qr.quietZoneModules;
  // Symbol box for a typical (version 5, 37-module) code: quiet zone = the ring around it.
  const mod = g.qrBox.w / (37 + 2 * qz);
  const idCap = m.capHeight('bold') * D.id.fontPt;
  return [
    s('guide-unit', { x: 0.15, y: 0.15, w: UNIT_W - 0.3, h: UNIT_H - 0.3 }),
    s(
      'guide-safe-area',
      { x: g.safeInset, y: g.safeInset, w: UNIT_W - 2 * g.safeInset, h: UNIT_H - 2 * g.safeInset },
      1.5,
    ),
    // Where artwork is visible (a 2.2 : 1 panel artwork fills exactly this).
    s('guide-artwork-area', {
      ...g.zones.emergency,
      x: 0.6,
      y: 0.6,
      w: g.zones.emergency.w - 1.2,
      h: UNIT_H - 1.2,
    }),
    s('guide-credential-panel', g.zones.credential, 0.8),
    s(
      'guide-id-area',
      { x: g.idBaselineX - idCap - 0.5, y: g.safeInset, w: idCap + 1, h: UNIT_H - 2 * g.safeInset },
      0.8,
    ),
    s('guide-target', g.target, 1),
    s('guide-quiet-zone', g.qrBox),
    s(
      'guide-qr',
      {
        x: g.qrBox.x + qz * mod,
        y: g.qrBox.y + qz * mod,
        w: g.qrBox.w - 2 * qz * mod,
        h: g.qrBox.h - 2 * qz * mod,
      },
      0.6,
    ),
    s('guide-cover-placement', g.coverFootprint, 1),
    s('guide-cover-cut', g.coverDie, undefined, mmToPt(D.coverCornerRadiusMm)),
  ];
}

/** Axis-aligned bounds of an element in unit coordinates (used by layout validation/tests). */
export function elementBounds(el: DrawElement): Box {
  switch (el.kind) {
    case 'rect':
    case 'logo-placeholder':
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case 'artwork': {
      // Visible extent = drawn box ∩ clip.
      const x = Math.max(el.x, el.clip.x);
      const y = Math.max(el.y, el.clip.y);
      return {
        x,
        y,
        w: Math.max(0, Math.min(el.x + el.w, el.clip.x + el.clip.w) - x),
        h: Math.max(0, Math.min(el.y + el.h, el.clip.y + el.clip.h) - y),
      };
    }
    case 'qr':
      return { x: el.x, y: el.y, w: el.size, h: el.size };
    case 'polygon': {
      const xs = el.points.map((p) => p[0]);
      const ys = el.points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case 'logo': {
      const vb = el.logo.viewBox;
      return {
        x: el.x + vb.x * el.scale,
        y: el.y + vb.y * el.scale,
        w: vb.width * el.scale,
        h: vb.height * el.scale,
      };
    }
    case 'text': {
      const left = el.anchor === 'middle' ? el.x - el.width / 2 : el.x;
      if (el.rotate === -90)
        return { x: el.x - el.capHeight, y: el.y - el.width, w: el.capHeight, h: el.width };
      return { x: left, y: el.y - el.capHeight, w: el.width, h: el.capHeight };
    }
  }
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS
  );
}
