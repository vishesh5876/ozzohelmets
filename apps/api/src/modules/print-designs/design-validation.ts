import {
  ARTWORK_OFFSET_RANGE_MM,
  ARTWORK_SCALE_RANGE,
  baseArtworkAspectMessage,
  baseArtworkFit,
  MIN_PRINT_DPI,
  type PrintArtworkFormat,
} from '@helmet/types';
import {
  type ArtworkPosition,
  baseArtworkTarget,
  coverTrim,
  drawnDpi,
  PANEL_W,
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
  artworkOnTop = false,
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

  const fit =
    base.format === 'SVG'
      ? baseArtworkFit(base.viewBox!.width, base.viewBox!.height)
      : baseArtworkFit(base.widthPx!, base.heightPx!);
  if (!fit) errors.push(baseArtworkAspectMessage(factsAspect(base)));
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
    // Coverage of the visible area (the emergency panel) is what matters for either fit.
    const t = fit === 'PANEL' ? baseArtworkTarget(factsAspect(base)) : { w: PANEL_W };
    const covers =
      baseBox.x <= 0.01 &&
      baseBox.y <= 0.01 &&
      baseBox.x + baseBox.w >= t.w - 0.01 &&
      baseBox.y + baseBox.h >= UNIT_H - 0.01;
    if (!covers)
      warnings.push(
        'At this position the artwork does not fill the emergency panel (left 2.2 × 1 in): uncovered areas print white.',
      );
    if (!artworkOnTop && fit === 'PANEL' && baseBox.x + baseBox.w > PANEL_W + 0.01)
      warnings.push(
        'At this scale/offset part of the panel artwork runs under the Safety ID column and is hidden.',
      );
    if (fit === 'FULL')
      warnings.push(
        artworkOnTop
          ? 'Design on top: the artwork shows across the Safety ID column too; only the QR, PIN and Safety ID text keep white boxes above it. The removable cover area (right 1.15 in) is never printed with the artwork.'
          : 'Full-width artwork under the Safety ID panel: only its left 2.2 in (55.9 mm) shows; the white Safety ID / QR column cuts through anything placed further right. Turn on "Design on top", or upload just the emergency panel at 2.2 : 1 (viewBox 0 0 220 100, or 1320 × 600 px).',
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
