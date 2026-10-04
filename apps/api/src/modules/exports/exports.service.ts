import { HttpStatus, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ErrorCode } from '@helmet/types';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EncryptionService } from '../../security/encryption.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditAction } from '../audit/audit-actions';
import { AuditService } from '../audit/audit.service';
import { csvRow } from './csv';

const PAGE_SIZE = 1000;
const HEADER = ['helmetCode', 'serialNumber', 'model', 'batchCode', 'qrUrl', 'activationPin'];

/**
 * Manufacturing CSV export. PINs are decrypted from escrow on the fly while streaming and are
 * never logged, cached or written to disk. The export is audited BEFORE any data is sent.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
  ) {}

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

    const pinsIncluded = await this.prisma.helmetActivationSecret.count({
      where: { helmet: { batchId } },
    });
    await this.audit.record({
      action: AuditAction.BATCH_EXPORT_MANUFACTURING_CSV,
      entityType: 'helmet_batch',
      entityId: batchId,
      adminId: admin.id,
      ipHash: meta.ipHash,
      metadata: { batchCode: batch.batchCode, helmets: batch.generatedCount, pinsIncluded },
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${batch.batchCode}-manufacturing.csv"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Pins-Included', String(pinsIncluded));
    res.write(csvRow(HEADER));

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
          publicToken: true,
          activationSecret: { select: { pinCiphertext: true } },
        },
      });
      if (page.length === 0) break;
      let chunk = '';
      for (const h of page) {
        const pin = h.activationSecret
          ? this.encryption.pinEscrow.decrypt(h.activationSecret.pinCiphertext, h.id)
          : '';
        chunk += csvRow([
          h.helmetCode,
          h.serialNumber,
          batch.helmetModel.name,
          batch.batchCode,
          this.config.publicHelmetUrl(h.publicToken),
          pin,
        ]);
      }
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
      cursor = page[page.length - 1]!.id;
      if (page.length < PAGE_SIZE) break;
    }
    res.end();
  }
}
