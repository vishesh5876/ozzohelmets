import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import {
  ErrorCode,
  placeUnit,
  planSheets,
  type PrintSheetLayout,
  SAFETY_ID_EXPORT_COLUMNS,
  unitsPerSheet,
} from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EncryptionService } from '../../security/encryption.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { SheetPdf } from '../print/pdf-renderer';
import { PrintService } from '../print/print.service';
import { layoutUnit, StickerLayoutError } from '../print/sticker-layout';
import { csvRow } from './csv';

const PAGE_SIZE = 1000;
/** Phase 8 columns kept in the same order (print templates rely on them); Safety ID appended. */
const HELMET_HEADER = [
  'helmetCode',
  'serialNumber',
  'model',
  'batchCode',
  'qrUrl',
  'activationPin',
  'safetyCode',
];
interface SafetyExportRow {
  id: string;
  safetyCode: string;
  publicToken: string;
  unitIndex: number | null;
  pinCiphertext: string | null;
  helmetCode: string | null;
  serialNumber: string | null;
  model: string | null;
}

/**
 * Manufacturing exports. PINs are decrypted from escrow on the fly while streaming and are never
 * logged, cached or written to disk. Every export is audited BEFORE any data is sent and served
 * with `Cache-Control: no-store`. Phase 9: the QR and PIN belong to the Safety ID (AAD = its id).
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly print: PrintService,
  ) {}

  /** Helmet batch CSV: one row per helmet with its linked Safety ID's QR URL and PIN. */
  async streamManufacturingCsv(
    batchId: string,
    admin: AuthenticatedAdmin,
    meta: RequestMeta,
    res: Response,
  ): Promise<void> {
    const batch = await this.prisma.helmetBatch.findUnique({
      where: { id: batchId },
      include: { helmetModel: { select: { name: true } } },
    });
    if (!batch) throw AppException.notFound(ErrorCode.BATCH_NOT_FOUND, 'Batch not found.');
    if (batch.generationStatus !== 'COMPLETED') {
      throw new AppException(
        ErrorCode.BATCH_NOT_GENERATED,
        'The batch has not finished generating.',
        HttpStatus.CONFLICT,
      );
    }
    const [{ n: pins } = { n: 0n }] = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM safety_id_activation_secrets s
      JOIN safety_id_helmet_links l ON l.safety_id = s.safety_id AND l.ended_at IS NULL
      JOIN helmets h ON h.id = l.helmet_id WHERE h.batch_id = ${batchId}::uuid`;
    const pinsIncluded = Number(pins);
    await this.audit.record({
      action: AuditAction.BATCH_EXPORT_MANUFACTURING_CSV,
      entityType: 'helmet_batch',
      entityId: batchId,
      adminId: admin.id,
      ipHash: meta.ipHash,
      metadata: { batchCode: batch.batchCode, helmets: batch.generatedCount, pinsIncluded },
    });

    this.startDownload(res, 'text/csv; charset=utf-8', `${batch.batchCode}-manufacturing.csv`);
    res.setHeader('X-Pins-Included', String(pinsIncluded));
    res.write(csvRow(HELMET_HEADER));

    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.helmet.findMany({
        where: { batchId },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          helmetCode: true,
          serialNumber: true,
          safetyIdLinks: {
            where: { endedAt: null },
            take: 1,
            select: {
              safetyIdRef: {
                select: {
                  id: true,
                  safetyCode: true,
                  publicToken: true,
                  activationSecret: { select: { pinCiphertext: true } },
                },
              },
            },
          },
        },
      });
      if (page.length === 0) break;
      let chunk = '';
      for (const h of page) {
        const s = h.safetyIdLinks[0]?.safetyIdRef;
        const pin = s?.activationSecret
          ? this.encryption.pinEscrow.decrypt(s.activationSecret.pinCiphertext, s.id)
          : '';
        chunk += csvRow([
          h.helmetCode,
          h.serialNumber,
          batch.helmetModel.name,
          batch.batchCode,
          s ? this.config.publicHelmetUrl(s.publicToken) : '',
          pin,
          s?.safetyCode ?? '',
        ]);
      }
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      cursor = page[page.length - 1]!.id;
      if (page.length < PAGE_SIZE) break;
    }
    res.end();
  }

  /**
   * Safety ID batch CSV (SAFETY_ID_EXPORT_COLUMNS), in print order: one row per unit, the same
   * order and sheet positions as the print PDF for the same layout.
   */
  async streamSafetyIdCsv(
    batchId: string,
    admin: AuthenticatedAdmin,
    meta: RequestMeta,
    res: Response,
    layout: PrintSheetLayout,
  ): Promise<void> {
    const batch = await this.safetyBatchForExport(batchId);
    const pinsIncluded = await this.prisma.safetyIdActivationSecret.count({
      where: { safetyIdRef: { batchId } },
    });
    await this.audit.record({
      action: AuditAction.SAFETY_ID_BATCH_EXPORTED,
      entityType: 'safety_id_batch',
      entityId: batchId,
      adminId: admin.id,
      ipHash: meta.ipHash,
      metadata: { batchCode: batch.batchCode, safetyIds: batch.generatedCount, pinsIncluded },
    });
    this.startDownload(res, 'text/csv; charset=utf-8', `${batch.batchCode}-safety-ids.csv`);
    res.setHeader('X-Pins-Included', String(pinsIncluded));
    res.write(csvRow(SAFETY_ID_EXPORT_COLUMNS));
    let ordinal = 0;
    for await (const page of this.safetyPages(batchId)) {
      let chunk = '';
      for (const r of page) {
        const url = this.config.publicHelmetUrl(r.publicToken);
        const at = placeUnit(ordinal++, layout);
        chunk += csvRow([
          r.safetyCode,
          url,
          this.pin(r),
          url,
          batch.batchCode,
          r.unitIndex ?? '',
          at.sheet,
          at.row,
          at.column,
          r.helmetCode ?? '',
          r.serialNumber ?? '',
          r.model ?? '',
        ]);
      }
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  }

  /**
   * True-size production PDF (default 12 × 18 in, 48-up): one 4.5 × 1 in unit per Safety ID —
   * emergency panel, ID/PIN/QR credential panel and the integrated yellow cover — in unit-index
   * order, row-major per sheet. Blank positions on the last sheet stay blank. Only while every
   * unit's PIN is still in escrow: after "mark printed" a PIN-bearing reprint is impossible.
   * Streamed straight to the response: no temp file, nothing persisted, PINs never logged.
   */
  async streamSafetyIdPrintPdf(
    batchId: string,
    admin: AuthenticatedAdmin,
    meta: RequestMeta,
    res: Response,
    layout: PrintSheetLayout,
    opts: { proof?: boolean; compress?: boolean } = {},
  ): Promise<void> {
    const batch = await this.safetyBatchForExport(batchId);
    if (batch.printStatus === 'PRINTED')
      throw this.escrowPurged('This batch was marked printed and its PIN escrow purged.');
    const [units, pinsIncluded] = await Promise.all([
      this.prisma.safetyId.count({ where: { batchId } }),
      this.prisma.safetyIdActivationSecret.count({ where: { safetyIdRef: { batchId } } }),
    ]);
    if (units === 0)
      throw new AppException(
        ErrorCode.CONFLICT,
        'The batch has no Safety IDs.',
        HttpStatus.CONFLICT,
      );
    if (pinsIncluded !== units)
      throw this.escrowPurged(
        `${units - pinsIncluded} Safety ID(s) of this batch no longer have a recoverable PIN.`,
      );
    this.print.assertProductionReady();
    const ctx = this.print.context(layout, { proof: opts.proof });
    const plan = planSheets(units, unitsPerSheet(layout));

    // Lay out the first unit before anything is sent, so a layout problem is a clean error.
    const first = await this.safetyPages(batchId).next();
    const firstRows = first.done ? [] : first.value;
    const unitData = (r: SafetyExportRow) => ({
      safetyCode: r.safetyCode,
      pin: this.pin(r),
      qrPayload: this.config.publicHelmetUrl(r.publicToken),
    });
    try {
      layoutUnit(unitData(firstRows[0]!), ctx);
    } catch (err) {
      if (err instanceof StickerLayoutError)
        throw new AppException(ErrorCode.PRINT_LAYOUT_INVALID, err.message, HttpStatus.CONFLICT);
      throw err;
    }

    await this.audit.record({
      action: AuditAction.SAFETY_ID_BATCH_PRINT_PDF,
      entityType: 'safety_id_batch',
      entityId: batchId,
      adminId: admin.id,
      ipHash: meta.ipHash,
      metadata: {
        batchCode: batch.batchCode,
        units,
        pinsIncluded,
        sheets: plan.sheets,
        unitsPerSheet: plan.unitsPerSheet,
        layout: `${layout.sheetWidthIn}x${layout.sheetHeightIn}in ${layout.columns}x${layout.rows}`,
        proof: opts.proof === true,
        logoSha256: ctx.logo?.sha256 ?? null,
      },
    });

    const suffix = opts.proof ? '-PROOF' : '';
    const pdf = new SheetPdf({
      layout,
      fonts: this.print.fonts,
      title: `${batch.batchCode} Safety ID print ${layout.sheetWidthIn}x${layout.sheetHeightIn} ${plan.unitsPerSheet}-up${suffix}`,
      compress: opts.compress,
      proofGuides: opts.proof ? ctx.geometry : undefined,
    });
    this.startDownload(
      res,
      'application/pdf',
      `${batch.batchCode}-print-${layout.sheetWidthIn}x${layout.sheetHeightIn}-${plan.unitsPerSheet}up${suffix}.pdf`,
    );
    res.setHeader('X-Pins-Included', String(pinsIncluded));
    res.setHeader('X-Print-Sheets', String(plan.sheets));
    res.setHeader('X-Print-Units', String(units));
    pdf.doc.pipe(res);
    try {
      let index = 0;
      const draw = (rows: SafetyExportRow[]) => {
        for (const r of rows) pdf.addUnit(index++, layoutUnit(unitData(r), ctx));
      };
      draw(firstRows);
      for await (const page of this.safetyPages(batchId, firstRows.length)) {
        draw(page);
        await new Promise((resolve) => setImmediate(resolve));
      }
      pdf.end();
    } catch (err) {
      // Headers are gone: abort the download rather than deliver an incomplete print file.
      this.logger.error(`Print PDF for ${batch.batchCode} aborted: ${(err as Error).message}`);
      pdf.doc.unpipe(res);
      res.destroy(err as Error);
    }
  }

  private escrowPurged(detail: string): AppException {
    return new AppException(
      ErrorCode.PIN_ESCROW_PURGED,
      `${detail} A reprint containing the original Activation PINs is impossible; issue new Safety IDs instead.`,
      HttpStatus.CONFLICT,
    );
  }

  private async safetyBatchForExport(batchId: string) {
    const batch = await this.prisma.safetyIdBatch.findUnique({
      where: { id: batchId },
      select: { batchCode: true, generatedCount: true, generationStatus: true, printStatus: true },
    });
    if (!batch) throw AppException.notFound(ErrorCode.BATCH_NOT_FOUND, 'Batch not found.');
    if (batch.generationStatus !== 'COMPLETED')
      throw new AppException(
        ErrorCode.BATCH_NOT_GENERATED,
        'The batch has not finished generating.',
        HttpStatus.CONFLICT,
      );
    return batch;
  }

  /** Print order: unit index ascending (ties/legacy rows by id). Offset paging over a fixed set. */
  private async *safetyPages(batchId: string, skip = 0): AsyncGenerator<SafetyExportRow[]> {
    for (let offset = skip; ; offset += PAGE_SIZE) {
      const page = await this.prisma.safetyId.findMany({
        where: { batchId },
        orderBy: [{ unitIndex: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        skip: offset,
        take: PAGE_SIZE,
        select: {
          id: true,
          safetyCode: true,
          publicToken: true,
          unitIndex: true,
          activationSecret: { select: { pinCiphertext: true } },
          helmetLinks: {
            where: { endedAt: null },
            take: 1,
            select: {
              helmet: {
                select: {
                  helmetCode: true,
                  serialNumber: true,
                  helmetModel: { select: { name: true } },
                },
              },
            },
          },
        },
      });
      if (page.length === 0) return;
      yield page.map((s) => {
        const h = s.helmetLinks[0]?.helmet;
        return {
          id: s.id,
          safetyCode: s.safetyCode,
          publicToken: s.publicToken,
          unitIndex: s.unitIndex,
          pinCiphertext: s.activationSecret?.pinCiphertext ?? null,
          helmetCode: h?.helmetCode ?? null,
          serialNumber: h?.serialNumber ?? null,
          model: h?.helmetModel.name ?? null,
        };
      });
      if (page.length < PAGE_SIZE) return;
    }
  }

  private pin(r: SafetyExportRow): string {
    return r.pinCiphertext ? this.encryption.pinEscrow.decrypt(r.pinCiphertext, r.id) : '';
  }

  private startDownload(res: Response, type: string, filename: string): void {
    res.status(200);
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}
