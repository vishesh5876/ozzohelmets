import { mmToPt, SAFETY_ID_UNIT_HEIGHT_IN, SAFETY_ID_UNIT_WIDTH_IN } from '@helmet/types';

/**
 * Fixed design of the 4.5 × 1 in Safety ID unit (one liner, three zones):
 *
 *   ┌──────────────────────┬──────────────┬──────────────┐
 *   │ OZZO                 │ I            │ (yellow      │
 *   │ IN CASE OF           │ D  PIN: …    │  removable   │
 *   │ EMERGENCY            │ :  [ QR ]    │  cover,      │
 *   │ FOR MY MEDICAL INFO  │ …            │  kiss-cut)   │
 *   │ [SCAN ME] ──────►    │              │              │
 *   └──────────────────────┴──────────────┴──────────────┘
 *     emergency 2.20 in      credential     cover 1.15 in
 *                            1.15 in
 *
 * Physical-QA adjustments are made HERE (one reviewed place), never by scaling the unit. Every
 * dependent size (protected target, cover, QR) is derived from these numbers by
 * computeStickerGeometry() and validated; nothing is drawn "approximately".
 */
export const STICKER_DESIGN = {
  unitWidthIn: SAFETY_ID_UNIT_WIDTH_IN,
  unitHeightIn: SAFETY_ID_UNIT_HEIGHT_IN,
  zones: { emergencyIn: 2.2, credentialIn: 1.15, coverIn: 1.15 },

  /** Assumed die/trim drift. Cover and quiet zone keep at least this from every cut line. */
  cutToleranceMm: 0.5,
  /** Cover margin beyond the protected target on every side (spec: 1–2 mm). */
  coverOverlapMm: 1.5,
  coverCornerRadiusMm: 1,
  /** Yellow ink beyond the cover die line (onto the weeded matrix) for kiss-cut drift. */
  coverPrintBleedMm: 1,

  qr: { errorCorrection: 'Q' as const, quietZoneModules: 4 },

  /** Rotated Safety ID along the left edge of the credential zone (stays visible when covered). */
  id: { fontPt: 5.6, insetFromZonePt: 2, gapToCoverPt: 1.5 },
  pin: { fontPt: 7.2, characterSpacingPt: 0.6, gapToQrPt: 1.2 },

  emergency: {
    logoHeightPt: 11,
    gapAfterLogoPt: 3.2,
    inCaseOfPt: 7.5,
    lineGapPt: 2.2,
    emergencyPt: 16,
    gapAfterEmergencyPt: 3,
    medicalPt: 6,
    scanMePt: 7.5,
    pillHeightPt: 11.5,
    pillPaddingXPt: 5,
    arrowGapPt: 3,
    arrowShaftPt: 1.6,
    arrowHeadPt: 6,
    /** The arrow tip stops this far before the credential zone. */
    arrowEndGapPt: 2.5,
    dividerColor: '#BDBDBD',
  },

  cover: {
    removePt: 10,
    onlyInPt: 7.5,
    emergencyPt: 7.5,
    lineGapPt: 2.4,
    tabHeightPt: 13,
    openPt: 7,
  },

  /** Corner marks on the base sticker showing where the cover goes (hidden once it is on). */
  alignmentMark: { lengthPt: 2.4, widthPt: 0.35, color: '#8C8C8C' },

  /** Print-safe solid colours (RGB in the PDF; CMYK equivalents in docs/SAFETY-ID-PRINT.md). */
  colors: { red: '#EC1C22', black: '#000000', white: '#FFFFFF' },
} as const;

/** Default cover yellow; overridable per vendor with PRINT_COVER_YELLOW. */
export const DEFAULT_COVER_YELLOW = '#FFD100';

export const UNIT_W = STICKER_DESIGN.unitWidthIn * 72;
export const UNIT_H = STICKER_DESIGN.unitHeightIn * 72;
export const CUT_TOL = mmToPt(STICKER_DESIGN.cutToleranceMm);
export const COVER_OVERLAP = mmToPt(STICKER_DESIGN.coverOverlapMm);
