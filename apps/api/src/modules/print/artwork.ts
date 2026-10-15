import { mmToPt } from '@helmet/types';
import type { Box } from './sticker-layout';
import { UNIT_H, UNIT_W } from './sticker-design';

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
 * Base artwork: the unit (4.5 × 1 in) scaled by `scalePercent` around its centre, moved by the
 * offsets; the artwork is fitted inside that box uniformly ("meet") and centred. At 100 % / 0 / 0
 * a 4.5 : 1 artwork covers the unit exactly.
 */
export function placeBaseArtwork(aspect: number, pos: ArtworkPosition): Box {
  const s = pos.scalePercent / 100;
  const boxW = UNIT_W * s;
  const boxH = UNIT_H * s;
  const w = Math.min(boxW, boxH * aspect);
  const h = w / aspect;
  return {
    x: UNIT_W / 2 + mmToPt(pos.offsetXMm) - w / 2,
    y: UNIT_H / 2 + mmToPt(pos.offsetYMm) - h / 2,
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
  return Math.floor(Math.min(widthPx / (drawn.w / 72), heightPx / (drawn.h / 72)));
}
