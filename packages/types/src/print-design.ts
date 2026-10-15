/**
 * Print Designs: admin-controlled ARTWORK for the 4.5 × 1 in Safety ID unit. The artwork is a
 * background only; the ID, PIN, QR, quiet zone, credential panel, cut and cover geometry stay
 * system-generated (print engine). Pure, browser-safe rules shared by API and admin.
 */
type IsoDateString = string;

export const PrintDesignStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;
export type PrintDesignStatus = (typeof PrintDesignStatus)[keyof typeof PrintDesignStatus];

export const PrintArtworkFormat = { SVG: 'SVG', PNG: 'PNG' } as const;
export type PrintArtworkFormat = (typeof PrintArtworkFormat)[keyof typeof PrintArtworkFormat];

export type PrintArtworkRole = 'base' | 'cover';

/** Base artwork covers the whole unit: 4.5 : 1. Uniform scaling only — never stretched. */
export const BASE_ARTWORK_ASPECT = 4.5;
/** Relative aspect-ratio tolerance (1 %): e.g. 2700 × 600 ok, 2700 × 610 rejected. */
export const ARTWORK_ASPECT_TOLERANCE = 0.01;
export const MIN_PRINT_DPI = 300;
export const RECOMMENDED_PRINT_DPI = 600;
/** 300 DPI over 4.5 × 1 in. */
export const MIN_BASE_PNG = { widthPx: 1350, heightPx: 300 } as const;
export const RECOMMENDED_BASE_PNG = { widthPx: 2700, heightPx: 600 } as const;

/** Artwork position controls: uniform scale (%) and offsets (mm). */
export const ARTWORK_SCALE_RANGE = { min: 50, max: 200 } as const;
export const ARTWORK_OFFSET_RANGE_MM = 25;

export function aspectMatches(width: number, height: number, target: number): boolean {
  if (!(width > 0 && height > 0)) return false;
  return Math.abs(width / height / target - 1) <= ARTWORK_ASPECT_TOLERANCE;
}

/** Effective DPI of a raster drawn `physicalWidthIn` wide (after the uniform scale). */
export function effectiveDpi(widthPx: number, physicalWidthIn: number): number {
  return Math.floor(widthPx / physicalWidthIn);
}

export type ArtworkQuality = 'VECTOR' | 'EXCELLENT' | 'GOOD' | 'TOO_LOW';

export function artworkQuality(format: PrintArtworkFormat, dpi: number | null): ArtworkQuality {
  if (format === 'SVG') return 'VECTOR';
  if (dpi === null || dpi < MIN_PRINT_DPI) return 'TOO_LOW';
  return dpi >= RECOMMENDED_PRINT_DPI ? 'EXCELLENT' : 'GOOD';
}

export const ARTWORK_QUALITY_LABEL: Record<ArtworkQuality, string> = {
  VECTOR: 'Best print quality',
  EXCELLENT: 'Excellent',
  GOOD: 'Good',
  TOO_LOW: 'Too low for production',
};

export interface PrintArtworkFileDto {
  id: string;
  format: PrintArtworkFormat;
  originalFilename: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  svgViewBox: string | null;
  /** Base artwork at 100 % scale (PNG only). */
  effectiveDpi: number | null;
  quality: ArtworkQuality;
  /** SUPER_ADMIN test-only upload below the production minimum: never activatable. */
  testOnly: boolean;
  warnings: string[];
  /** Same bytes were uploaded before: the existing file is reused. */
  duplicate?: boolean;
  createdAt: IsoDateString;
}

export interface PrintDesignPositionDto {
  /** Percent, uniform (aspect ratio locked). */
  scalePercent: number;
  offsetXMm: number;
  offsetYMm: number;
}

export interface PrintDesignDto extends PrintDesignPositionDto {
  id: string;
  /** All versions of one design share a family id. */
  familyId: string;
  name: string;
  version: number;
  status: PrintDesignStatus;
  artworkType: PrintArtworkFormat;
  baseArtwork: PrintArtworkFileDto;
  coverArtwork: PrintArtworkFileDto | null;
  /** Base artwork effective DPI at the current scale (PNG). */
  effectiveDpi: number | null;
  quality: ArtworkQuality;
  /** Physical size of the scaled base artwork. */
  artworkSizeMm: { width: number; height: number };
  validationErrors: string[];
  validationWarnings: string[];
  /** Used by at least one Safety ID batch: immutable (edit = new version). */
  locked: boolean;
  usedByBatches: number;
  createdBy: { id: string; name: string } | null;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  activatedAt: IsoDateString | null;
  archivedAt: IsoDateString | null;
}

export interface CreatePrintDesignRequest extends Partial<PrintDesignPositionDto> {
  name: string;
  baseArtworkFileId: string;
  coverArtworkFileId?: string | null;
}

export type UpdatePrintDesignRequest = Partial<CreatePrintDesignRequest>;

/** Design reference stored on a Safety ID batch (immutable once the batch exists). */
export interface BatchPrintDesignDto {
  id: string;
  name: string;
  version: number;
  status: PrintDesignStatus;
  artworkType: PrintArtworkFormat;
}
