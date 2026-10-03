import { HttpStatus } from '@nestjs/common';
import sharp from 'sharp';
import { ErrorCode } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import { sniffImage } from './image-processor';

export interface ProcessedDocument {
  data: Buffer;
  contentType: 'image/webp' | 'application/pdf';
  extension: 'webp' | 'pdf';
}

const MAX_INPUT_DIMENSION = 10_000;
/** Large enough to keep an invoice legible after re-encoding. */
const IMAGE_OUTPUT_MAX = 2400;

/** PDF features that can execute or carry payloads; never needed on an invoice. */
const PDF_FORBIDDEN = [
  /\/JavaScript\b/,
  /\/JS\b/,
  /\/Launch\b/,
  /\/EmbeddedFile\b/,
  /\/RichMedia\b/,
];

const invalid = (message: string) =>
  new AppException(ErrorCode.INVALID_FILE, message, HttpStatus.BAD_REQUEST);

export function isPdf(buf: Buffer): boolean {
  return buf.length > 8 && buf.toString('latin1', 0, 5) === '%PDF-';
}

/**
 * Validates a proof-of-purchase upload by content (magic bytes), never by name or client MIME:
 * - JPEG/PNG/WebP → fully decoded and re-encoded to WebP (metadata incl. GPS stripped);
 * - PDF → structural sanity check, active content (JavaScript, launch actions, embedded files)
 *   rejected; stored as-is and only ever served as a download (`attachment`, `nosniff`).
 */
export async function processProofOfPurchase(
  input: Buffer,
  maxBytes: number,
): Promise<ProcessedDocument> {
  if (input.length === 0) throw invalid('The file is empty.');
  if (input.length > maxBytes)
    throw invalid(`Files must be smaller than ${Math.floor(maxBytes / 1_048_576)} MB.`);

  if (isPdf(input)) {
    const tail = input.toString('latin1', Math.max(0, input.length - 2048));
    if (!tail.includes('%%EOF')) throw invalid('The PDF appears to be incomplete.');
    const body = input.toString('latin1');
    if (PDF_FORBIDDEN.some((re) => re.test(body)))
      throw invalid('PDFs with scripts or embedded files are not accepted.');
    return { data: input, contentType: 'application/pdf', extension: 'pdf' };
  }

  if (!sniffImage(input)) throw invalid('Upload a JPEG, PNG, WebP image or a PDF.');
  try {
    const data = await sharp(input, {
      limitInputPixels: MAX_INPUT_DIMENSION * MAX_INPUT_DIMENSION,
    })
      .rotate()
      .resize(IMAGE_OUTPUT_MAX, IMAGE_OUTPUT_MAX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    return { data, contentType: 'image/webp', extension: 'webp' };
  } catch {
    throw invalid('The image could not be read.');
  }
}
