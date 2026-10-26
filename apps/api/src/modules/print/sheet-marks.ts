import { gridHeightIn, gridWidthIn, inToPt, mmToPt, type PrintSheetLayout } from '@helmet/types';
import type { DrawElement, TextMetrics } from './sticker-layout';

/**
 * Sheet-level marks for printing on your own printer and cutting on a print-and-cut plotter.
 * Drawn only in the outer margins, in sheet coordinates (pt from the sheet's top-left):
 *
 * - four solid 5 mm registration squares beside the corners of the unit grid, at the same
 *   positions on the print sheet and the cut guide, so the cutter (or its software) can align
 *   the cut to what was actually printed;
 * - a 100 mm scale bar: if it does not measure exactly 100 mm, the printer scaled the page
 *   ("fit to page") and the cuts will not line up.
 *
 * The edge-to-edge print-shop preset has no margins, so it gets none of this.
 */

export const REG_MARK_MM = 5;
/** Clear space between a registration mark and the nearest unit (bleed included). */
export const REG_MARK_GAP_MM = 5;
/** Space a desktop printer can't print at the paper edge. */
export const PRINTER_EDGE_MM = 6;
export const SCALE_BAR_MM = 100;

const SCALE_LABEL = 'PRINT AT 100% (ACTUAL SIZE): THIS BAR MUST MEASURE 100 mm';

/** Squares as boxes (sheet pt); empty when the side margins can't hold them. */
export function registrationMarks(l: PrintSheetLayout) {
  const s = mmToPt(REG_MARK_MM);
  const gap = mmToPt(REG_MARK_GAP_MM);
  if (inToPt(l.outerMarginXIn) < s + gap + mmToPt(PRINTER_EDGE_MM)) return [];
  const left = inToPt(l.outerMarginXIn);
  const right = left + inToPt(gridWidthIn(l));
  const top = inToPt(l.outerMarginYIn);
  const bottom = top + inToPt(gridHeightIn(l));
  return [
    { x: left - gap - s, y: top, w: s, h: s },
    { x: right + gap, y: top, w: s, h: s },
    { x: left - gap - s, y: bottom - s, w: s, h: s },
    { x: right + gap, y: bottom - s, w: s, h: s },
  ];
}

/** Registration squares + scale bar for a print sheet (the cut guide uses the squares only). */
export function sheetMarks(l: PrintSheetLayout, m: TextMetrics): DrawElement[] {
  const marks = registrationMarks(l);
  if (!marks.length) return [];
  const out: DrawElement[] = marks.map((b) => ({
    kind: 'rect',
    role: 'registration-mark',
    ...b,
    fill: '#000000',
  }));

  // Vertical scale bar in the left margin, centred on the grid, with its label beside it.
  const bar = mmToPt(SCALE_BAR_MM);
  const top = inToPt(l.outerMarginYIn);
  const gridH = inToPt(gridHeightIn(l));
  const size = 5;
  const width = m.width(SCALE_LABEL, 'bold', size);
  const capHeight = m.capHeight('bold') * size;
  const x = marks[0]!.x - mmToPt(8);
  const labelX = x - mmToPt(3);
  if (gridH < bar || width > gridH || labelX - capHeight < mmToPt(PRINTER_EDGE_MM)) return out;
  const y = top + (gridH - bar) / 2;
  const tick = mmToPt(3);
  out.push(
    { kind: 'rect', role: 'scale-bar', x: x - 0.5, y, w: 1, h: bar, fill: '#000000' },
    {
      kind: 'rect',
      role: 'scale-bar',
      x: x - tick / 2,
      y: y - 0.25,
      w: tick,
      h: 0.5,
      fill: '#000000',
    },
    {
      kind: 'rect',
      role: 'scale-bar',
      x: x - tick / 2,
      y: y + bar - 0.25,
      w: tick,
      h: 0.5,
      fill: '#000000',
    },
    {
      kind: 'text',
      role: 'scale-label',
      text: SCALE_LABEL,
      x: labelX,
      y: top + gridH / 2 + width / 2,
      anchor: 'start',
      rotate: -90,
      weight: 'bold',
      size,
      fill: '#000000',
      characterSpacing: 0,
      width,
      capHeight,
    },
  );
  return out;
}
