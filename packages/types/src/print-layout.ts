/**
 * Phase 9 physical print: sheet geometry for Safety ID sticker units. Pure, browser-safe math
 * shared by the API (PDF engine) and the admin (preview, sheet counts, layout validation).
 *
 * One Safety ID print unit = ONE 4.5 × 1 in sticker that already contains its removable yellow
 * QR cover. The unit is never scaled: a layout that does not fit is a validation error.
 */

export const PT_PER_INCH = 72;
export const MM_PER_INCH = 25.4;

export const inToPt = (inches: number): number => inches * PT_PER_INCH;
export const mmToPt = (mm: number): number => (mm * PT_PER_INCH) / MM_PER_INCH;
export const mmToIn = (mm: number): number => mm / MM_PER_INCH;

/** The finished Safety ID unit. Fixed: the artwork is designed for exactly this size. */
export const SAFETY_ID_UNIT_WIDTH_IN = 4.5;
export const SAFETY_ID_UNIT_HEIGHT_IN = 1;

/** Geometry of one production sheet. Lengths in inches except bleed and safe area (mm). */
export interface PrintSheetLayout {
  sheetWidthIn: number;
  sheetHeightIn: number;
  unitWidthIn: number;
  unitHeightIn: number;
  columns: number;
  rows: number;
  outerMarginXIn: number;
  outerMarginYIn: number;
  /** Space between columns. */
  gutterXIn: number;
  /** Space between rows. */
  gutterYIn: number;
  /** Artwork extension beyond each unit's trim line (needs margin/gutter room). */
  bleedMm: number;
  /** Text/logo inset from every cut edge. */
  safeAreaMm: number;
}

export const DEFAULT_PRINT_PRESET = '12x18_48UP';
/** Own printer + print-and-cut plotter: printer-safe margins, gaps between units and bleed. */
export const CUTTER_PRINT_PRESET = '12x18_30UP_CUTTER';

/** 18 / 4.5 = 4 columns, 12 / 1 = 12 rows: 48 complete units, zero margin and gutter. */
export const PRINT_PRESETS: Readonly<Record<string, Readonly<PrintSheetLayout>>> = {
  [DEFAULT_PRINT_PRESET]: {
    sheetWidthIn: 18,
    sheetHeightIn: 12,
    unitWidthIn: SAFETY_ID_UNIT_WIDTH_IN,
    unitHeightIn: SAFETY_ID_UNIT_HEIGHT_IN,
    columns: 4,
    rows: 12,
    outerMarginXIn: 0,
    outerMarginYIn: 0,
    gutterXIn: 0,
    gutterYIn: 0,
    bleedMm: 0,
    safeAreaMm: 2,
  },
  /**
   * 3 × 10 = 30 units with 0.1 in gaps, so every unit has its own cut and 1.2 mm of bleed: a cut
   * that drifts shows design, never a white sliver. 0.55 in top/bottom and 2.15 in side margins
   * stay clear of a desktop printer's unprintable edge and hold the registration marks and the
   * scale bar.
   */
  [CUTTER_PRINT_PRESET]: {
    sheetWidthIn: 18,
    sheetHeightIn: 12,
    unitWidthIn: SAFETY_ID_UNIT_WIDTH_IN,
    unitHeightIn: SAFETY_ID_UNIT_HEIGHT_IN,
    columns: 3,
    rows: 10,
    outerMarginXIn: 2.15,
    outerMarginYIn: 0.55,
    gutterXIn: 0.1,
    gutterYIn: 0.1,
    bleedMm: 1.2,
    safeAreaMm: 2,
  },
};

/** Admin-facing names for the presets. */
export const PRINT_PRESET_LABELS: Readonly<Record<string, string>> = {
  [DEFAULT_PRINT_PRESET]: '12 × 18 in, 48-up — print shop (edge to edge)',
  [CUTTER_PRINT_PRESET]: '12 × 18 in, 30-up — own printer + cutter (margins, bleed, marks)',
};

/** The preset a layout exactly matches, if any. */
export function presetOf(l: PrintSheetLayout): string | null {
  for (const [name, p] of Object.entries(PRINT_PRESETS))
    if (PRINT_LAYOUT_FIELDS.every((f) => Math.abs(p[f] - l[f]) < EPS)) return name;
  return null;
}

export const DEFAULT_PRINT_LAYOUT: Readonly<PrintSheetLayout> =
  PRINT_PRESETS[DEFAULT_PRINT_PRESET]!;

export const FULL_SHEET_WARNING =
  "48-up uses the full 12 × 18 inch sheet with shared cut lines. Confirm your print vendor's trimming/bleed requirements.";

export const PRINT_LAYOUT_FIELDS: readonly (keyof PrintSheetLayout)[] = [
  'sheetWidthIn',
  'sheetHeightIn',
  'unitWidthIn',
  'unitHeightIn',
  'columns',
  'rows',
  'outerMarginXIn',
  'outerMarginYIn',
  'gutterXIn',
  'gutterYIn',
  'bleedMm',
  'safeAreaMm',
];

export interface PrintLayoutIssue {
  field: keyof PrintSheetLayout | 'layout';
  message: string;
}

/** Tolerance for float comparisons (1/100 000 in). */
const EPS = 1e-5;
const MAX_SHEET_IN = 60;
const MAX_GRID = 200;

/** Every reason the layout can't be printed. Empty = valid. Labels are never scaled to fit. */
export function validatePrintLayout(l: PrintSheetLayout): PrintLayoutIssue[] {
  const issues: PrintLayoutIssue[] = [];
  for (const f of PRINT_LAYOUT_FIELDS) {
    const v = l[f];
    if (typeof v !== 'number' || !Number.isFinite(v))
      issues.push({ field: f, message: 'Must be a number.' });
  }
  if (issues.length) return issues;
  const positive = (f: keyof PrintSheetLayout, max: number) => {
    if (l[f] <= 0 || l[f] > max) issues.push({ field: f, message: `Must be > 0 and ≤ ${max}.` });
  };
  const nonNegative = (f: keyof PrintSheetLayout, max: number) => {
    if (l[f] < 0 || l[f] > max) issues.push({ field: f, message: `Must be between 0 and ${max}.` });
  };
  positive('sheetWidthIn', MAX_SHEET_IN);
  positive('sheetHeightIn', MAX_SHEET_IN);
  for (const f of ['columns', 'rows'] as const)
    if (!Number.isInteger(l[f]) || l[f] < 1 || l[f] > MAX_GRID)
      issues.push({ field: f, message: `Must be a whole number from 1 to ${MAX_GRID}.` });
  nonNegative('outerMarginXIn', 10);
  nonNegative('outerMarginYIn', 10);
  nonNegative('gutterXIn', 10);
  nonNegative('gutterYIn', 10);
  nonNegative('bleedMm', 5);
  if (l.safeAreaMm < 1 || l.safeAreaMm > 4)
    issues.push({ field: 'safeAreaMm', message: 'Must be between 1 and 4 mm.' });
  if (Math.abs(l.unitWidthIn - SAFETY_ID_UNIT_WIDTH_IN) > EPS)
    issues.push({
      field: 'unitWidthIn',
      message: `The Safety ID unit is exactly ${SAFETY_ID_UNIT_WIDTH_IN} in wide (sticker + cover). Labels are never scaled.`,
    });
  if (Math.abs(l.unitHeightIn - SAFETY_ID_UNIT_HEIGHT_IN) > EPS)
    issues.push({
      field: 'unitHeightIn',
      message: `The Safety ID unit is exactly ${SAFETY_ID_UNIT_HEIGHT_IN} in high. Labels are never scaled.`,
    });
  if (issues.length) return issues;

  const needW = gridWidthIn(l) + 2 * l.outerMarginXIn;
  const needH = gridHeightIn(l) + 2 * l.outerMarginYIn;
  if (needW > l.sheetWidthIn + EPS)
    issues.push({
      field: 'layout',
      message: `${l.columns} columns need ${round(needW)} in of sheet width (with margins and gutters); the sheet is ${l.sheetWidthIn} in.`,
    });
  if (needH > l.sheetHeightIn + EPS)
    issues.push({
      field: 'layout',
      message: `${l.rows} rows need ${round(needH)} in of sheet height (with margins and gutters); the sheet is ${l.sheetHeightIn} in.`,
    });
  const bleedIn = mmToIn(l.bleedMm);
  if (bleedIn > EPS) {
    // Bleed of neighbouring units must not overlap, and the outer bleed must stay on the sheet.
    const roomX = Math.min(l.columns > 1 ? l.gutterXIn / 2 : Infinity, l.outerMarginXIn);
    const roomY = Math.min(l.rows > 1 ? l.gutterYIn / 2 : Infinity, l.outerMarginYIn);
    if (bleedIn > roomX + EPS || bleedIn > roomY + EPS)
      issues.push({
        field: 'bleedMm',
        message:
          'Bleed needs room: at most half the gutter and at most the outer margin. Shared cut lines (zero gutter) allow no bleed.',
      });
  }
  return issues;
}

/** Neighbouring units share a cut line in at least one direction. */
export function isSharedCutLayout(l: PrintSheetLayout): boolean {
  return l.gutterXIn <= EPS || l.gutterYIn <= EPS;
}

/** True when the layout uses the whole sheet with no margin: show FULL_SHEET_WARNING. */
export function needsFullSheetWarning(l: PrintSheetLayout): boolean {
  return isSharedCutLayout(l) && (l.outerMarginXIn <= EPS || l.outerMarginYIn <= EPS);
}

export function unitsPerSheet(l: PrintSheetLayout): number {
  return l.columns * l.rows;
}

export interface SheetPlan {
  units: number;
  unitsPerSheet: number;
  sheets: number;
  fullSheets: number;
  /** Units on the last sheet (equals unitsPerSheet when it is full; 0 when there are no units). */
  lastSheetUnits: number;
}

/** `sheets = ceil(quantity / unitsPerSheet)`. Empty positions are never filled with duplicates. */
export function planSheets(quantity: number, perSheet: number): SheetPlan {
  if (!Number.isInteger(quantity) || quantity < 0) throw new RangeError('quantity');
  if (!Number.isInteger(perSheet) || perSheet < 1) throw new RangeError('perSheet');
  const sheets = Math.ceil(quantity / perSheet);
  const fullSheets = Math.floor(quantity / perSheet);
  const remainder = quantity % perSheet;
  return {
    units: quantity,
    unitsPerSheet: perSheet,
    sheets,
    fullSheets,
    lastSheetUnits: quantity === 0 ? 0 : remainder === 0 ? perSheet : remainder,
  };
}

export interface UnitPlacement {
  /** 1-based sheet (PDF page) number. */
  sheet: number;
  /** 1-based row (top = 1) and column (left = 1). */
  row: number;
  column: number;
  /** 1-based position on its sheet, row-major from the top-left. */
  position: number;
  /** Top-left corner of the unit's trim box, in PDF points from the sheet's top-left. */
  xPt: number;
  yPt: number;
}

/** Deterministic row-major placement of the `index`-th (0-based) unit of an export. */
export function placeUnit(index: number, l: PrintSheetLayout): UnitPlacement {
  const per = unitsPerSheet(l);
  const onSheet = index % per;
  const row = Math.floor(onSheet / l.columns);
  const column = onSheet % l.columns;
  return {
    sheet: Math.floor(index / per) + 1,
    row: row + 1,
    column: column + 1,
    position: onSheet + 1,
    xPt: inToPt(l.outerMarginXIn + column * (l.unitWidthIn + l.gutterXIn)),
    yPt: inToPt(l.outerMarginYIn + row * (l.unitHeightIn + l.gutterYIn)),
  };
}

export function gridWidthIn(l: PrintSheetLayout): number {
  return l.columns * l.unitWidthIn + (l.columns - 1) * l.gutterXIn;
}

export function gridHeightIn(l: PrintSheetLayout): number {
  return l.rows * l.unitHeightIn + (l.rows - 1) * l.gutterYIn;
}

/** Reads a layout from flat query values, falling back to the preset for missing fields. */
export function layoutFromQuery(
  query: Partial<Record<keyof PrintSheetLayout, unknown>>,
  base: PrintSheetLayout = DEFAULT_PRINT_LAYOUT,
): PrintSheetLayout {
  const out = { ...base };
  for (const f of PRINT_LAYOUT_FIELDS) {
    const raw = query[f];
    if (raw === undefined || raw === null || raw === '') continue;
    out[f] = typeof raw === 'number' ? raw : Number(String(raw));
  }
  return out;
}

/** Flat query values for a layout (only the fields that differ from the preset). */
export function layoutToQuery(
  l: PrintSheetLayout,
  base: PrintSheetLayout = DEFAULT_PRINT_LAYOUT,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of PRINT_LAYOUT_FIELDS) if (l[f] !== base[f]) out[f] = String(l[f]);
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
