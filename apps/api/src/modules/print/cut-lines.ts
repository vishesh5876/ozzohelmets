import { inToPt, type PrintSheetLayout, placeUnit, unitsPerSheet } from '@helmet/types';
import type { StickerGeometry } from './sticker-layout';
import { STICKER_DESIGN, UNIT_H, UNIT_W } from './sticker-design';
import { mmToPt } from '@helmet/types';

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CutPlan {
  /** Through-cut (unit trim) lines. Shared edges appear ONCE (no double cuts). */
  through: Segment[];
  /** Kiss cut between the base sticker and the cover zone, one per unit. */
  kissBase: Segment[];
  /** Kiss-cut cover outlines (rounded rectangles), one per unit. */
  kissCover: { x: number; y: number; w: number; h: number; r: number }[];
}

/** Merges collinear touching/overlapping spans keyed by their fixed coordinate. */
function merge(spans: Map<number, [number, number][]>): [number, [number, number]][] {
  const out: [number, [number, number]][] = [];
  for (const [k, list] of [...spans.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a[0] - b[0]);
    let cur = list[0]!;
    for (const s of list.slice(1)) {
      if (s[0] <= cur[1] + 1e-6) cur = [cur[0], Math.max(cur[1], s[1])];
      else {
        out.push([k, cur]);
        cur = s;
      }
    }
    out.push([k, cur]);
  }
  return out;
}

const key = (n: number) => Math.round(n * 1000) / 1000;

/** Cut paths for every position on a sheet (the die is the same for every sheet). */
export function planCuts(layout: PrintSheetLayout, g: StickerGeometry): CutPlan {
  const h = new Map<number, [number, number][]>();
  const v = new Map<number, [number, number][]>();
  const add = (map: Map<number, [number, number][]>, k: number, a: number, b: number) => {
    const kk = key(k);
    map.set(kk, [...(map.get(kk) ?? []), [a, b]]);
  };
  const kissBase: Segment[] = [];
  const kissCover: CutPlan['kissCover'] = [];
  const r = mmToPt(STICKER_DESIGN.coverCornerRadiusMm);
  for (let i = 0; i < unitsPerSheet(layout); i++) {
    const p = placeUnit(i, layout);
    add(h, p.yPt, p.xPt, p.xPt + UNIT_W);
    add(h, p.yPt + UNIT_H, p.xPt, p.xPt + UNIT_W);
    add(v, p.xPt, p.yPt, p.yPt + UNIT_H);
    add(v, p.xPt + UNIT_W, p.yPt, p.yPt + UNIT_H);
    const bx = p.xPt + g.zones.cover.x;
    kissBase.push({ x1: bx, y1: p.yPt, x2: bx, y2: p.yPt + UNIT_H });
    kissCover.push({
      x: p.xPt + g.coverDie.x,
      y: p.yPt + g.coverDie.y,
      w: g.coverDie.w,
      h: g.coverDie.h,
      r,
    });
  }
  const through: Segment[] = [
    ...merge(h).map(([y, [a, b]]) => ({ x1: a, y1: y, x2: b, y2: y })),
    ...merge(v).map(([x, [a, b]]) => ({ x1: x, y1: a, x2: x, y2: b })),
  ];
  return { through, kissBase, kissCover };
}

export const sheetSizePt = (l: PrintSheetLayout) => ({
  width: inToPt(l.sheetWidthIn),
  height: inToPt(l.sheetHeightIn),
});
