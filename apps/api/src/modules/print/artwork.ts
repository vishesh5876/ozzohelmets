import { aspectMatches, mmToPt, PANEL_ARTWORK_ASPECT } from '@helmet/types';
import type { Box } from './sticker-layout';
import { STICKER_DESIGN, UNIT_H, UNIT_W } from './sticker-design';

/** The emergency panel (left of the Safety ID column): the only place artwork is visible. */
export const PANEL_W = STICKER_DESIGN.zones.emergencyIn * 72;

/**
 * Admin artwork placement. INVARIANT: artwork is only ever scaled uniformly — the drawn box always
 * has exactly the artwork's own aspect ratio (width / height). No independent X/Y scaling exists
 * anywhere in this module, so a logo can never be stretched.
 */

export interface ArtworkAsset {
  /** SHA-256 of the stored bytes (also the per-document cache key). */
  key: string;
  format: 'SVG' | 'PNG';
  /** Sanitized SVG (vector, rendered as vector into the PDF). */
  svg?: string;
  viewBox?: { x: number; y: number; width: number; height: number };
  /** Original PNG bytes (embedded losslessly, once per PDF). */
  png?: Buffer;
  widthPx?: number;
  heightPx?: number;
}

export interface ArtworkPosition {
  scalePercent: number;
  offsetXMm: number;
  offsetYMm: number;
}

export const DEFAULT_POSITION: ArtworkPosition = { scalePercent: 100, offsetXMm: 0, offsetYMm: 0 };

/** Width / height of the artwork's intrinsic box. */
export function artworkAspect(
  a: Pick<ArtworkAsset, 'format' | 'viewBox' | 'widthPx' | 'heightPx'>,
): number {
  if (a.format === 'SVG') return a.viewBox!.width / a.viewBox!.height;
  return a.widthPx! / a.heightPx!;
}

/**
 * The area a base artwork is designed for: the emergency panel (2.2 × 1 in) for a 2.2 : 1 file,
 * otherwise the whole unit (4.5 × 1 in).
 */
export function baseArtworkTarget(aspect: number): Box {
  return aspectMatches(aspect, 1, PANEL_ARTWORK_ASPECT)
    ? { x: 0, y: 0, w: PANEL_W, h: UNIT_H }
    : { x: 0, y: 0, w: UNIT_W, h: UNIT_H };
}

/**
 * Base artwork: its target area (panel or unit) scaled by `scalePercent` around its centre, moved
 * by the offsets; the artwork is fitted inside that box uniformly ("meet") and centred. At
 * 100 % / 0 / 0 a 2.2 : 1 artwork fills the emergency panel exactly and a 4.5 : 1 one the unit.
 */
export function placeBaseArtwork(aspect: number, pos: ArtworkPosition): Box {
  const t = baseArtworkTarget(aspect);
  const s = pos.scalePercent / 100;
  const boxW = t.w * s;
  const boxH = t.h * s;
  const w = Math.min(boxW, boxH * aspect);
  const h = w / aspect;
  return {
    x: t.x + t.w / 2 + mmToPt(pos.offsetXMm) - w / 2,
    y: t.y + t.h / 2 + mmToPt(pos.offsetYMm) - h / 2,
    w,
    h,
  };
}

/** Cover artwork: uniformly scaled to fill the cover print box ("slice"), centred, then clipped. */
export function placeCoverArtwork(aspect: number, box: Box): Box {
  const w = Math.max(box.w, box.h * aspect);
  const h = w / aspect;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Fraction of the artwork trimmed by the cover clip on its most-trimmed axis (0 = none). */
export function coverTrim(aspect: number, box: Box): number {
  const placed = placeCoverArtwork(aspect, box);
  return Math.max(1 - box.w / placed.w, 1 - box.h / placed.h);
}

/** Effective print resolution of a raster drawn into `drawn` (pt): the lower axis. */
export function drawnDpi(widthPx: number, heightPx: number, drawn: Box): number {
  // The epsilon absorbs float error (2.2 in = 158.40000000000003 pt) so 440 px is 200 DPI, not 199.
  return Math.floor(Math.min(widthPx / (drawn.w / 72), heightPx / (drawn.h / 72)) + 1e-9);
}
