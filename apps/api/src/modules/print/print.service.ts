import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_PRINT_LAYOUT,
  DEFAULT_PRINT_PRESET,
  ErrorCode,
  FULL_SHEET_WARNING,
  layoutFromQuery,
  needsFullSheetWarning,
  type PrintSheetLayout,
  type SafetyIdPrintStatusDto,
  type SafetyIdStickerGeometryDto,
  unitsPerSheet,
  validatePrintLayout,
} from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import { AppConfigService } from '../../config/app-config.service';
import { type LogoAsset, LogoAssetError, parseLogoSvg } from './logo-asset';
import { createTextMetrics, type PrintFonts } from './pdf-renderer';
import { COVER_OVERLAP, CUT_TOL, STICKER_DESIGN, UNIT_H, UNIT_W } from './sticker-design';
import {
  computeStickerGeometry,
  type LayoutContext,
  layoutUnit,
  qrMatrix,
  type StickerGeometry,
  type TextMetrics,
  type UnitData,
} from './sticker-layout';
import { sheetSvg, unitSvg } from './svg-renderer';

const PT_TO_MM = 25.4 / 72;
const mm = (pt: number) => Math.round(pt * PT_TO_MM * 100) / 100;

/** Preview-only sample (never printed): a non-existent token, an obviously sample PIN. */
const SAMPLE_TOKEN = 'PreviewSample000000000';
const SAMPLE_CODE = 'SI-ABCD-EFGH';
const SAMPLE_PIN = '123456';

/**
 * Loads the print assets once (logo, fonts, cover colour) and builds layout contexts for the PDF
 * engine and the admin previews. Missing/invalid logo never crashes the API: the status says
 * why, and production print PDFs are refused until it is fixed.
 */
@Injectable()
export class PrintService {
  private readonly logger = new Logger(PrintService.name);
  readonly fonts: PrintFonts;
  readonly metrics: TextMetrics;
  readonly yellow: string;
  private readonly logo: LogoAsset | null = null;
  private readonly logoError: string | null = null;
  private readonly geometries = new Map<number, StickerGeometry>();

  constructor(private readonly config: AppConfigService) {
    const path = (v: string | undefined) => (v && v.trim() ? resolve(v.trim()) : null);
    this.fonts = {
      regularPath: path(config.get('PRINT_FONT_REGULAR_PATH')),
      boldPath: path(config.get('PRINT_FONT_BOLD_PATH')),
    };
    this.metrics = createTextMetrics(this.fonts);
    this.yellow = config.get('PRINT_COVER_YELLOW').toUpperCase();
    const logoPath = path(config.get('PRINT_LOGO_SVG_PATH'));
    if (!logoPath) {
      this.logoError = 'PRINT_LOGO_SVG_PATH is not set.';
    } else {
      try {
        this.logo = parseLogoSvg(readFileSync(logoPath, 'utf8'), logoPath);
      } catch (err) {
        this.logoError =
          err instanceof LogoAssetError
            ? err.message
            : `Logo file could not be read (${(err as Error).message}).`;
      }
    }
    if (this.logoError) this.logger.warn(`Print logo unavailable: ${this.logoError}`);
  }

  /** Validated layout from query fields (preset defaults); never scaled to fit. */
  resolveLayout(query: Record<string, unknown> = {}): PrintSheetLayout {
    const preset = query.preset;
    if (preset !== undefined && preset !== DEFAULT_PRINT_PRESET)
      throw this.invalid([{ field: 'layout', message: `Unknown preset "${String(preset)}".` }]);
    const layout = layoutFromQuery(query);
    const issues = validatePrintLayout(layout);
    if (issues.length) throw this.invalid(issues);
    return layout;
  }

  geometry(layout: PrintSheetLayout): StickerGeometry {
    let g = this.geometries.get(layout.safeAreaMm);
    if (!g) {
      try {
        g = computeStickerGeometry(layout.safeAreaMm, this.metrics);
      } catch (err) {
        throw this.invalid([{ field: 'safeAreaMm', message: (err as Error).message }]);
      }
      this.geometries.set(layout.safeAreaMm, g);
    }
    return g;
  }

  context(layout: PrintSheetLayout, opts: { proof?: boolean } = {}): LayoutContext {
    return {
      geometry: this.geometry(layout),
      metrics: this.metrics,
      logo: this.logo,
      yellow: this.yellow,
      proof: opts.proof,
    };
  }

  get logoLoaded(): boolean {
    return this.logo !== null;
  }

  /** Production PIN-bearing PDFs need the faithful logo; development/test may use a placeholder. */
  assertProductionReady(): void {
    if (this.logo || !this.config.isProduction) return;
    throw new AppException(
      ErrorCode.PRINT_LOGO_MISSING,
      `The OZZO logo vector asset is not available (${this.logoError}) Production print files need the original logo artwork.`,
      HttpStatus.CONFLICT,
    );
  }

  status(layout: PrintSheetLayout = DEFAULT_PRINT_LAYOUT): SafetyIdPrintStatusDto {
    return {
      preset: DEFAULT_PRINT_PRESET,
      layout,
      unitsPerSheet: unitsPerSheet(layout),
      fullSheetWarning: needsFullSheetWarning(layout) ? FULL_SHEET_WARNING : null,
      logo: {
        loaded: this.logo !== null,
        sha256: this.logo?.sha256 ?? null,
        source: this.logo?.source ?? null,
        error: this.logoError,
      },
      productionReady: this.logo !== null,
      geometry: this.geometryDto(this.geometry(layout), layout),
    };
  }

  geometryDto(g: StickerGeometry, layout: PrintSheetLayout): SafetyIdStickerGeometryDto {
    const matrix = qrMatrix(this.config.publicHelmetUrl(SAMPLE_TOKEN));
    const qz = STICKER_DESIGN.qr.quietZoneModules;
    const mod = g.qrBox.w / (matrix.size + 2 * qz);
    return {
      unit: { widthMm: mm(UNIT_W), heightMm: mm(UNIT_H) },
      zones: {
        emergencyMm: mm(g.zones.emergency.w),
        credentialMm: mm(g.zones.credential.w),
        coverMm: mm(g.zones.cover.w),
      },
      target: { widthMm: mm(g.target.w), heightMm: mm(g.target.h) },
      cover: {
        widthMm: mm(g.coverDie.w),
        heightMm: mm(g.coverDie.h),
        overlapMm: mm(COVER_OVERLAP),
      },
      qr: {
        sizeMm: mm(g.qrBox.w),
        moduleMm: Math.round(mod * PT_TO_MM * 1000) / 1000,
        modules: matrix.size,
        quietZoneModules: qz,
        quietZoneMm: mm(qz * mod),
        errorCorrection: STICKER_DESIGN.qr.errorCorrection,
      },
      safeAreaMm: layout.safeAreaMm,
      cutToleranceMm: mm(CUT_TOL),
    };
  }

  sampleUnit(): UnitData {
    return {
      safetyCode: SAMPLE_CODE,
      pin: SAMPLE_PIN,
      qrPayload: this.config.publicHelmetUrl(SAMPLE_TOKEN),
    };
  }

  previewUnitSvg(layout: PrintSheetLayout, proof = false): string {
    return unitSvg(layoutUnit(this.sampleUnit(), this.context(layout, { proof })), {
      outline: true,
    });
  }

  previewSheetSvg(layout: PrintSheetLayout, filled: number): string {
    const ctx = this.context(layout);
    return sheetSvg(layout, ctx.geometry, layoutUnit(this.sampleUnit(), ctx), filled);
  }

  private invalid(issues: { field: string; message: string }[]): AppException {
    return new AppException(
      ErrorCode.PRINT_LAYOUT_INVALID,
      issues.map((i) => i.message).join(' '),
      HttpStatus.BAD_REQUEST,
      { issues },
    );
  }
}
