import { createHash } from 'node:crypto';

/**
 * The OZZO logo for the print engine, loaded from a vector SVG derived from the ORIGINAL artwork
 * (exported from the source file, outlines only). The engine never redraws, stretches or
 * reinterprets it: path data is used verbatim and scaled uniformly. Only the colour treatment
 * is applied here — the four letters are identified by path id:
 *
 *   ozzo-o1 → BLACK   ozzo-z1 → OZZO RED #EC1C22   ozzo-z2 → BLACK   ozzo-o2 → BLACK
 *
 * Several paths may make up one letter (`ozzo-o1`, `ozzo-o1-counter`, …). Rejected, so a bad
 * export can't silently distort the mark: transforms, strokes, missing letters, unknown paths,
 * non-path shapes, missing viewBox. See docs/SAFETY-ID-PRINT.md → Logo asset.
 */

export const OZZO_RED = '#EC1C22';
export const PRINT_BLACK = '#000000';
export const LOGO_LETTERS = ['o1', 'z1', 'z2', 'o2'] as const;
export type LogoLetter = (typeof LOGO_LETTERS)[number];

export const LOGO_LETTER_COLORS: Readonly<Record<LogoLetter, string>> = {
  o1: PRINT_BLACK,
  z1: OZZO_RED,
  z2: PRINT_BLACK,
  o2: PRINT_BLACK,
};

export interface LogoPath {
  letter: LogoLetter;
  /** SVG path data, verbatim from the asset. */
  d: string;
  fillRule: 'nonzero' | 'evenodd';
  fill: string;
}

export interface LogoAsset {
  viewBox: { x: number; y: number; width: number; height: number };
  paths: LogoPath[];
  sha256: string;
  source: string;
}

export class LogoAssetError extends Error {}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? '') : null;
};

const SHAPES = /<(rect|circle|ellipse|polygon|polyline|line|text|image|use)\b/i;

export function parseLogoSvg(svg: string, source: string): LogoAsset {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) throw new LogoAssetError('Not an SVG file.');
  const vb = attr(root, 'viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (!vb || vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2]! <= 0 || vb[3]! <= 0)
    throw new LogoAssetError('The SVG needs a numeric viewBox.');
  if (/\stransform\s*=/i.test(svg))
    throw new LogoAssetError(
      'Transforms are not allowed: re-export with transforms applied to the path coordinates.',
    );
  if (/\sstroke\s*=\s*["'](?!none)/i.test(svg) || /stroke\s*:\s*(?!none)/i.test(svg))
    throw new LogoAssetError('Strokes are not allowed: outline strokes before exporting.');
  const shape = SHAPES.exec(svg.replace(/<defs[\s\S]*?<\/defs>/gi, ''));
  if (shape) throw new LogoAssetError(`Only <path> elements are allowed (found <${shape[1]}>).`);

  const paths: LogoPath[] = [];
  for (const m of svg.matchAll(/<path\b[^>]*>/gi)) {
    const tag = m[0];
    const id = attr(tag, 'id') ?? '';
    const letter = /^ozzo-(o1|z1|z2|o2)(?:-[\w-]+)?$/.exec(id)?.[1] as LogoLetter | undefined;
    if (!letter)
      throw new LogoAssetError(
        `Every path must be one letter: id "ozzo-o1", "ozzo-z1", "ozzo-z2" or "ozzo-o2" (got "${id}").`,
      );
    const d = attr(tag, 'd')?.trim();
    if (!d || !/^[Mm]/.test(d)) throw new LogoAssetError(`Path "${id}" has no path data.`);
    if (/[^0-9MmLlHhVvCcSsQqTtAaZz.,\s+eE-]/.test(d))
      throw new LogoAssetError(`Path "${id}" contains unsupported path data.`);
    const rule = (
      attr(tag, 'fill-rule') ?? /fill-rule\s*:\s*(\w+)/i.exec(attr(tag, 'style') ?? '')?.[1]
    )?.toLowerCase();
    paths.push({
      letter,
      d,
      fillRule: rule === 'evenodd' ? 'evenodd' : 'nonzero',
      fill: LOGO_LETTER_COLORS[letter],
    });
  }
  for (const l of LOGO_LETTERS)
    if (!paths.some((p) => p.letter === l))
      throw new LogoAssetError(`Letter "ozzo-${l}" is missing.`);
  return {
    viewBox: { x: vb[0]!, y: vb[1]!, width: vb[2]!, height: vb[3]! },
    paths,
    sha256: createHash('sha256').update(svg).digest('hex'),
    source,
  };
}
