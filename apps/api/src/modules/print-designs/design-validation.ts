import {
  ARTWORK_OFFSET_RANGE_MM,
  ARTWORK_SCALE_RANGE,
  aspectMatches,
  BASE_ARTWORK_ASPECT,
  MIN_PRINT_DPI,
  type PrintArtworkFormat,
} from '@helmet/types';
import {
  type ArtworkPosition,
  coverTrim,
  drawnDpi,
  placeBaseArtwork,
  placeCoverArtwork,
} from '../print/artwork';
import type { Box } from '../print/sticker-layout';
import { UNIT_H, UNIT_W } from '../print/sticker-design';

/** What validation needs to know about an artwork file (from server-side inspection). */
export interface ArtworkFacts {
  format: PrintArtworkFormat;
  widthPx: number | null;
  heightPx: number | null;
  viewBox: { width: number; height: number } | null;
  testOnly: boolean;
  warnings: string[];
}

export function factsAspect(f: ArtworkFacts): number {
  return f.format === 'SVG' ? f.viewBox!.width / f.viewBox!.height : f.widthPx! / f.heightPx!;
}

export interface DesignCheck {
  errors: string[];
  warnings: string[];
  /** Base artwork effective DPI at this position (PNG only). */
  effectiveDpi: number | null;
  baseBox: Box;
}

/**
 * Static design rules (no I/O). A design with errors stays DRAFT and can't be used for a batch.
 * Rendering checks (sample PDF) run separately in the service.
 */
export function checkDesign(
  base: ArtworkFacts,
  cover: ArtworkFacts | null,
  pos: ArtworkPosition,
  coverBox: Box,
): DesignCheck {
  const errors: string[] = [];
  const warnings: string[] = [...base.warnings.map((w) => `Base artwork: ${w}`)];
  if (
    !Number.isFinite(pos.scalePercent) ||
    pos.scalePercent < ARTWORK_SCALE_RANGE.min ||
    pos.scalePercent > ARTWORK_SCALE_RANGE.max
  )
    errors.push(
      `Scale must be between ${ARTWORK_SCALE_RANGE.min}% and ${ARTWORK_SCALE_RANGE.max}%.`,
    );
  for (const [k, v] of [
    ['X offset', pos.offsetXMm],
    ['Y offset', pos.offsetYMm],
  ] as const)
    if (!Number.isFinite(v) || Math.abs(v) > ARTWORK_OFFSET_RANGE_MM)
      errors.push(`${k} must be within ±${ARTWORK_OFFSET_RANGE_MM} mm.`);

  const aspectOk =
    base.format === 'SVG'
      ? aspectMatches(base.viewBox!.width, base.viewBox!.height, BASE_ARTWORK_ASPECT)
      : aspectMatches(base.widthPx!, base.heightPx!, BASE_ARTWORK_ASPECT);
  if (!aspectOk)
    errors.push(
      `Base artwork must be 4.5 : 1 (it is ${factsAspect(base).toFixed(3)} : 1). Crop it to 4.5 × 1 in (e.g. 2700 × 600 px or viewBox 0 0 450 100); artwork is never stretched.`,
    );
  if (base.testOnly)
    errors.push(
      'Base artwork is a test-only low-resolution upload: it cannot be used for production.',
    );

  const baseBox = errors.length
    ? { x: 0, y: 0, w: UNIT_W, h: UNIT_H }
    : placeBaseArtwork(factsAspect(base), pos);
  let effectiveDpi: number | null = null;
  if (base.format === 'PNG' && !errors.length) {
    effectiveDpi = drawnDpi(base.widthPx!, base.heightPx!, baseBox);
    if (effectiveDpi < MIN_PRINT_DPI)
      errors.push(
        `Base artwork prints at ${effectiveDpi} DPI at this scale — too low for production (minimum ${MIN_PRINT_DPI} DPI).`,
      );
  }
  if (!errors.length) {
    const covers =
      baseBox.x <= 0.01 &&
      baseBox.y <= 0.01 &&
      baseBox.x + baseBox.w >= UNIT_W - 0.01 &&
      baseBox.y + baseBox.h >= UNIT_H - 0.01;
    if (!covers)
      warnings.push(
        'The artwork does not cover the whole 4.5 × 1 in unit at this position: uncovered areas print white.',
      );
  }

  if (cover) {
    warnings.push(...cover.warnings.map((w) => `Cover artwork: ${w}`));
    if (cover.testOnly)
      errors.push(
        'Cover artwork is a test-only low-resolution upload: it cannot be used for production.',
      );
    const aspect = factsAspect(cover);
    const trim = coverTrim(aspect, coverBox);
    if (trim > 0.05)
      warnings.push(
        `Cover artwork aspect ${aspect.toFixed(2)} differs from the cover area (${(coverBox.w / coverBox.h).toFixed(2)}): ${Math.round(trim * 100)}% is trimmed to fill it.`,
      );
    if (cover.format === 'PNG') {
      const dpi = drawnDpi(cover.widthPx!, cover.heightPx!, placeCoverArtwork(aspect, coverBox));
      if (dpi < MIN_PRINT_DPI)
        errors.push(
          `Cover artwork prints at ${dpi} DPI — too low for production (minimum ${MIN_PRINT_DPI} DPI).`,
        );
    }
  }
  return { errors, warnings, effectiveDpi, baseBox };
}
