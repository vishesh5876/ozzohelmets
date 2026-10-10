import { HttpStatus } from '@nestjs/common';
import sharp, { type Metadata } from 'sharp';
import { ErrorCode } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';

export type ImageKind = 'jpeg' | 'png' | 'webp';

/** Identifies JPEG/PNG/WebP from magic bytes. File names and client MIME types are not trusted. */
export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  return null;
}

export interface ProcessedImage {
  data: Buffer;
  contentType: 'image/webp';
  width: number;
  height: number;
}

const MIN_DIMENSION = 64;
const MAX_INPUT_DIMENSION = 6000;
const OUTPUT_MAX = 800;

const invalid = (message: string) =>
  new AppException(ErrorCode.INVALID_FILE, message, HttpStatus.BAD_REQUEST);

/**
 * Validates and re-encodes a profile photo: fully decodes it (rejecting polyglots and corrupt
 * files), applies EXIF orientation, strips ALL metadata (including GPS), downsizes and stores
 * a fresh WebP. SVG and other formats are rejected.
 */
export async function processProfilePhoto(
  input: Buffer,
  maxBytes: number,
): Promise<ProcessedImage> {
  if (input.length === 0) throw invalid('The file is empty.');
  if (input.length > maxBytes)
    throw invalid(`Photos must be smaller than ${Math.floor(maxBytes / 1_048_576)} MB.`);
  if (!sniffImage(input)) throw invalid('Upload a JPEG, PNG or WebP image.');

  let meta: Metadata;
  try {
    meta = await sharp(input, {
      limitInputPixels: MAX_INPUT_DIMENSION * MAX_INPUT_DIMENSION,
    }).metadata();
  } catch {
    throw invalid('The image could not be read.');
  }
  if (!meta.width || !meta.height || !['jpeg', 'png', 'webp'].includes(meta.format ?? ''))
    throw invalid('Upload a JPEG, PNG or WebP image.');
  if (meta.width < MIN_DIMENSION || meta.height < MIN_DIMENSION)
    throw invalid(`Photos must be at least ${MIN_DIMENSION}×${MIN_DIMENSION} pixels.`);
  if (meta.width > MAX_INPUT_DIMENSION || meta.height > MAX_INPUT_DIMENSION)
    throw invalid(`Photos must be at most ${MAX_INPUT_DIMENSION} pixels per side.`);

  try {
    const { data, info } = await sharp(input, {
      limitInputPixels: MAX_INPUT_DIMENSION * MAX_INPUT_DIMENSION,
    })
      .rotate()
      .resize(OUTPUT_MAX, OUTPUT_MAX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return { data, contentType: 'image/webp', width: info.width, height: info.height };
  } catch {
    throw invalid('The image could not be processed.');
  }
}
