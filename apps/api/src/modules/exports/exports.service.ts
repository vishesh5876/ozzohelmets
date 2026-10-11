import { HttpStatus, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ErrorCode, SAFETY_ID_EXPORT_COLUMNS } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EncryptionService } from '../../security/encryption.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { LabelsService } from '../labels/labels.service';
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
/** Print sheet wording, verbatim from the Phase 9 specification. */
export const PRINT_PIN_INSTRUCTION = 'Use this PIN once to activate your Safety ID.';

interface SafetyExportRow {
  id: string;
  safetyCode: string;
  publicToken: string;
  pinCiphertext: string | null;
  helmetCode: string | null;
  serialNumber: string | null;
  model: string | null;
}

const escapeHtml = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * Manufacturing exports. PINs are decrypted from escrow on the fly while streaming and are never
 * logged, cached or written to disk. Every export is audited BEFORE any data is sent and served
 * with `Cache-Control: no-store`. Phase 9: the QR and PIN belong to the Safety ID (AAD = its id).
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly labels: LabelsService,
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

  /** Safety ID batch CSV (SAFETY_ID_EXPORT_COLUMNS). */
  async streamSafetyIdCsv(
    batchId: string,
    admin: AuthenticatedAdmin,
    meta: RequestMeta,
    res: Response,
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
    for await (const page of this.safetyPages(batchId)) {
      let chunk = '';
      for (const r of page)
        chunk += csvRow([
          r.safetyCode,
          this.config.publicHelmetUrl(r.publicToken),
          this.pin(r),
          r.helmetCode ?? '',
          r.serialNumber ?? '',
          r.model ?? '',
          batch.batchCode,
        ]);
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  }

  /**
   * Print-ready HTML sheet: QR + Safety ID + Activation PIN together on each label, with the
   * one-time-use instruction. Opened in a browser and printed; nothing is stored server-side.
   */
  async streamSafetyIdPrintSheet(
    batchId: string,
    admin: AuthenticatedAdmin,
    meta: RequestMeta,
    res: Response,
  ): Promise<void> {
    const batch = await this.safetyBatchForExport(batchId);
    const pinsIncluded = await this.prisma.safetyIdActivationSecret.count({
      where: { safetyIdRef: { batchId } },
    });
    await this.audit.record({
      action: AuditAction.SAFETY_ID_BATCH_PRINT_SHEET,
      entityType: 'safety_id_batch',
      entityId: batchId,
      adminId: admin.id,
      ipHash: meta.ipHash,
      metadata: { batchCode: batch.batchCode, safetyIds: batch.generatedCount, pinsIncluded },
    });
    this.startDownload(res, 'text/html; charset=utf-8', `${batch.batchCode}-print-sheet.html`);
    // The sheet is self-contained: no scripts, no external resources.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    res.write(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(batch.batchCode)} Safety ID labels</title>
<style>
  @page { size: A4; margin: 10mm; }
  body { font-family: Arial, Helvetica, sans-serif; margin: 0; color: #000; }
  h1 { font-size: 12pt; margin: 0 0 4mm; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
  .label { border: 1px dashed #999; padding: 3mm; break-inside: avoid; text-align: center; }
  .label svg { width: 32mm; height: 32mm; }
  .code { font: bold 11pt monospace; letter-spacing: 0.5px; }
  .pin { font: bold 13pt monospace; letter-spacing: 2px; margin-top: 2mm; }
  .hint { font-size: 7pt; margin-top: 1mm; }
  .helmet { font-size: 7pt; color: #333; margin-top: 1mm; }
</style></head><body>
<h1>${escapeHtml(batch.batchCode)} · ${batch.generatedCount} Safety IDs · ${pinsIncluded} PINs</h1>
<div class="grid">
`);
    for await (const page of this.safetyPages(batchId)) {
      let chunk = '';
      for (const r of page) {
        const qr = await this.labels.qrSvg(this.config.publicHelmetUrl(r.publicToken));
        const pin = this.pin(r);
        chunk += `<div class="label">${qr}<div class="code">${escapeHtml(r.safetyCode)}</div>${
          pin
            ? `<div class="pin">PIN ${escapeHtml(pin)}</div><div class="hint">${PRINT_PIN_INSTRUCTION}</div>`
            : '<div class="hint">Activation PIN no longer available for printing.</div>'
        }${r.helmetCode ? `<div class="helmet">Helmet ${escapeHtml(r.helmetCode)}</div>` : ''}</div>\n`;
      }
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end('</div></body></html>\n');
  }

  private async safetyBatchForExport(batchId: string) {
    const batch = await this.prisma.safetyIdBatch.findUnique({
      where: { id: batchId },
      select: { batchCode: true, generatedCount: true, generationStatus: true },
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

  private async *safetyPages(batchId: string): AsyncGenerator<SafetyExportRow[]> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.safetyId.findMany({
        where: { batchId },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          safetyCode: true,
          publicToken: true,
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
          pinCiphertext: s.activationSecret?.pinCiphertext ?? null,
          helmetCode: h?.helmetCode ?? null,
          serialNumber: h?.serialNumber ?? null,
          model: h?.helmetModel.name ?? null,
        };
      });
      cursor = page[page.length - 1]!.id;
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
