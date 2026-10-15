import sharp from 'sharp';
import { ArtworkError } from './svg-sanitizer';

/**
 * Server-side PNG inspection (client metadata is never trusted).
 *
 * 1. Signature + IHDR are read from the raw bytes BEFORE any decompression, so a decompression
 *    bomb (tiny file, gigantic declared size) is refused without allocating its pixels.
 * 2. Only formats the PDF engine embeds losslessly as-is: 8-bit (or palette ≤ 8-bit), not
 *    interlaced. The PNG is embedded in the PDF with its own Flate data — never JPEG-compressed,
 *    never resized, never re-encoded on upload.
 * 3. A full decode with a pixel limit proves the image is not truncated/corrupt.
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngInfo {
  widthPx: number;
  heightPx: number;
  bitDepth: number;
  colorType: number;
  hasAlpha: boolean;
}

export interface PngLimits {
  maxBytes: number;
  maxPixels: number;
}

const COLOR_TYPES: Record<number, string> = {
  0: 'grayscale',
  2: 'RGB',
  3: 'palette',
  4: 'grayscale+alpha',
  6: 'RGBA',
};

export function isPng(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Header-only checks (no decompression). */
export function readPngHeader(buf: Buffer, limits: PngLimits): PngInfo {
  if (buf.length > limits.maxBytes)
    throw new ArtworkError(`PNG is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`);
  if (!isPng(buf)) throw new ArtworkError('Not a PNG file.');
  if (buf.length < 33 || buf.toString('latin1', 12, 16) !== 'IHDR')
    throw new ArtworkError('Malformed PNG: missing IHDR header.');
  const widthPx = buf.readUInt32BE(16);
  const heightPx = buf.readUInt32BE(20);
  const bitDepth = buf[24]!;
  const colorType = buf[25]!;
  const interlace = buf[28]!;
  if (widthPx === 0 || heightPx === 0) throw new ArtworkError('Malformed PNG: zero size.');
  if (widthPx > 30_000 || heightPx > 30_000 || widthPx * heightPx > limits.maxPixels)
    throw new ArtworkError(
      `PNG is too large when decoded (${widthPx} × ${heightPx} px; limit ${limits.maxPixels.toLocaleString('en')} pixels).`,
    );
  if (!(colorType in COLOR_TYPES)) throw new ArtworkError('Malformed PNG: unknown colour type.');
  if (bitDepth === 16)
    throw new ArtworkError('16-bit PNG is not supported for print: export as 8-bit PNG.');
  if (colorType !== 3 && bitDepth !== 8)
    throw new ArtworkError(`Unsupported PNG bit depth ${bitDepth}: export as 8-bit PNG.`);
  if (interlace !== 0)
    throw new ArtworkError('Interlaced PNG is not supported: export non-interlaced.');
  const hasAlpha = colorType === 4 || colorType === 6 || hasChunk(buf, 'tRNS');
  return { widthPx, heightPx, bitDepth, colorType, hasAlpha };
}

/** Header checks + a full bounded decode (detects truncated or corrupt image data). */
export async function inspectPng(buf: Buffer, limits: PngLimits): Promise<PngInfo> {
  const info = readPngHeader(buf, limits);
  try {
    const decoded = await sharp(buf, { limitInputPixels: limits.maxPixels, failOn: 'warning' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (decoded.info.width !== info.widthPx || decoded.info.height !== info.heightPx)
      throw new Error('size mismatch');
  } catch {
    throw new ArtworkError('The PNG could not be decoded (corrupt or truncated file).');
  }
  return info;
}

function hasChunk(buf: Buffer, type: string): boolean {
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const t = buf.toString('latin1', off + 4, off + 8);
    if (t === type) return true;
    if (t === 'IDAT' || t === 'IEND') return false;
    off += 12 + len;
  }
  return false;
}
