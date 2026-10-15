import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode, type SafetyIdBatchDto, type SafetyIdBatchStatsDto } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { buildMeta } from '../../common/dto/pagination.dto';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { PrintDesignsService } from '../print-designs/print-designs.service';
import type { CreateSafetyIdBatchDto, SafetyIdBatchQueryDto } from './dto/safety-id.dto';
import {
  SafetyIdGenerationService,
  STALE_SAFETY_GENERATION_MS,
} from './generation/safety-id-generation.service';

const include = {
  creator: { select: { id: true, name: true } },
  helmetBatch: { select: { id: true, batchCode: true, withSafetyIds: true } },
  printDesign: { select: { id: true, name: true, version: true, status: true, artworkType: true } },
} satisfies Prisma.SafetyIdBatchInclude;

type Row = Prisma.SafetyIdBatchGetPayload<{ include: typeof include }>;

const EXPORT_ACTIONS = [
  AuditAction.SAFETY_ID_BATCH_EXPORTED,
  AuditAction.SAFETY_ID_BATCH_PRINT_SHEET,
  AuditAction.SAFETY_ID_BATCH_PRINT_PDF,
];

/**
 * Safety ID batches (`SID-YYYY-NNNNN`): STANDALONE (free stickers/cards) or HELMET_LINKED (one
 * Safety ID for each helmet of a helmet batch that has none). Generation is a durable, resumable
 * chunked job; "mark printed" moves GENERATED → PRINTED and purges the PIN escrow for good.
 */
@Injectable()
export class SafetyIdBatchesService {
  private readonly logger = new Logger(SafetyIdBatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly generator: SafetyIdGenerationService,
    private readonly designs: PrintDesignsService,
  ) {}

  async list(query: SafetyIdBatchQueryDto): Promise<PaginatedResult<SafetyIdBatchDto>> {
    const where: Prisma.SafetyIdBatchWhereInput = {
      ...(query.mode ? { mode: query.mode } : {}),
      ...(query.search
        ? {
            OR: [
              { batchCode: { contains: query.search.toUpperCase() } },
              { helmetBatch: { batchCode: { contains: query.search.toUpperCase() } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.safetyIdBatch.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.safetyIdBatch.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const [escrow, exports] = await Promise.all([this.escrowCounts(ids), this.exportHistory(ids)]);
    return new PaginatedResult(
      rows.map((r) => this.toDto(r, escrow.get(r.id) ?? 0, exports.get(r.id))),
      buildMeta(query.page, query.pageSize, total),
    );
  }

  async get(id: string): Promise<SafetyIdBatchDto> {
    const row = await this.prisma.safetyIdBatch.findUnique({ where: { id }, include });
    if (!row) throw AppException.notFound(ErrorCode.BATCH_NOT_FOUND, 'Batch not found.');
    const [escrow, exports, stats] = await Promise.all([
      this.escrowCounts([id]),
      this.exportHistory([id]),
      this.stats(id),
    ]);
    return { ...this.toDto(row, escrow.get(id) ?? 0, exports.get(id)), stats };
  }

  async create(
    dto: CreateSafetyIdBatchDto,
    admin: AuthenticatedAdmin,
    meta: RequestMeta,
  ): Promise<SafetyIdBatchDto> {
    let quantity: number;
    let helmetBatchId: string | null = null;
    if (dto.mode === 'STANDALONE') {
      if (!dto.quantity || dto.helmetBatchId)
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'A standalone batch needs a quantity and no helmet batch.',
          HttpStatus.BAD_REQUEST,
        );
      const max = this.config.get('BATCH_MAX_QUANTITY');
      if (dto.quantity > max)
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          `Quantity cannot exceed ${max}.`,
          HttpStatus.BAD_REQUEST,
        );
      quantity = dto.quantity;
    } else {
      if (!dto.helmetBatchId || dto.quantity)
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'A helmet-linked batch needs a helmet batch (the quantity is the number of its helmets without a Safety ID).',
          HttpStatus.BAD_REQUEST,
        );
      const hb = await this.prisma.helmetBatch.findUnique({
        where: { id: dto.helmetBatchId },
        select: { generationStatus: true },
      });
      if (!hb) throw AppException.notFound(ErrorCode.BATCH_NOT_FOUND, 'Helmet batch not found.');
      if (hb.generationStatus !== 'COMPLETED')
        throw AppException.conflict(
          ErrorCode.BATCH_NOT_GENERATED,
          'Generate the helmet batch first (or create it with Safety IDs).',
        );
      quantity = await this.generator.countHelmetsWithoutSafetyId(dto.helmetBatchId);
      if (quantity === 0)
        throw AppException.conflict(
          ErrorCode.CONFLICT,
          'Every helmet of this batch already has a Safety ID.',
        );
      helmetBatchId = dto.helmetBatchId;
    }
    // Bind an exact, validated design version now; later design edits never affect this batch.
    const design = await this.designs.resolveForNewBatch(dto.printDesignId);
    const id = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        { n: bigint }[]
      >`SELECT nextval('safety_id_batch_code_seq') AS n`;
      const batchCode = `SID-${new Date().getUTCFullYear()}-${String(row?.n ?? 0).padStart(5, '0')}`;
      const batch = await tx.safetyIdBatch.create({
        data: {
          batchCode,
          mode: dto.mode,
          helmetBatchId,
          quantity,
          notes: dto.notes,
          createdBy: admin.id,
          printDesignId: design?.id ?? null,
          printDesignVersion: design?.version ?? null,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_BATCH_CREATED,
          entityType: 'safety_id_batch',
          entityId: batch.id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: {
            batchCode,
            mode: dto.mode,
            quantity,
            helmetBatchId,
            printDesignId: design?.id ?? null,
            printDesignVersion: design?.version ?? null,
          },
        },
        tx,
      );
      return batch.id;
    });
    return this.get(id);
  }

  /** Claims the batch (atomic; safe across instances) and runs generation in the background. */
  async startGeneration(
    id: string,
    admin: AuthenticatedAdmin,
    meta: RequestMeta,
  ): Promise<SafetyIdBatchDto> {
    const row = await this.prisma.safetyIdBatch.findUnique({
      where: { id },
      select: { mode: true, helmetBatch: { select: { withSafetyIds: true } } },
    });
    if (!row) throw AppException.notFound(ErrorCode.BATCH_NOT_FOUND, 'Batch not found.');
    if (row.helmetBatch?.withSafetyIds)
      throw AppException.conflict(
        ErrorCode.CONFLICT,
        'This batch is generated together with its helmet batch. Generate the helmet batch instead.',
      );
    const staleCutoff = new Date(Date.now() - STALE_SAFETY_GENERATION_MS);
    const claimed = await this.prisma.safetyIdBatch.updateMany({
      where: {
        id,
        OR: [
          { generationStatus: { in: ['PENDING', 'FAILED'] } },
          { generationStatus: 'GENERATING', updatedAt: { lt: staleCutoff } },
        ],
      },
      data: {
        generationStatus: 'GENERATING',
        generationStartedAt: new Date(),
        generationError: null,
      },
    });
    if (claimed.count !== 1) {
      const batch = await this.get(id);
      throw batch.generationStatus === 'GENERATING'
        ? AppException.conflict(
            ErrorCode.BATCH_GENERATION_IN_PROGRESS,
            'Generation is already in progress.',
          )
        : AppException.conflict(
            ErrorCode.BATCH_ALREADY_GENERATED,
            'This batch has already been generated.',
          );
    }
    const batch = await this.get(id);
    await this.audit.record({
      action: AuditAction.BATCH_GENERATION_STARTED,
      entityType: 'safety_id_batch',
      entityId: id,
      adminId: admin.id,
      ipHash: meta.ipHash,
      metadata: {
        batchCode: batch.batchCode,
        quantity: batch.quantity,
        alreadyGenerated: batch.generatedCount,
      },
    });
    void this.generator
      .run(id, admin.id)
      .catch((err: Error) => this.logger.error(`Safety ID generation crashed: ${err.message}`));
    return batch;
  }

  /** Confirms the labels were printed: GENERATED → PRINTED and the PIN escrow is purged for good. */
  async markPrinted(
    id: string,
    admin: AuthenticatedAdmin,
    meta: RequestMeta,
  ): Promise<SafetyIdBatchDto> {
    await this.prisma.$transaction(async (tx) => {
      const [batch] = await tx.$queryRaw<
        { generation_status: string; print_status: string; batch_code: string }[]
      >`SELECT generation_status, print_status, batch_code FROM safety_id_batches WHERE id = ${id}::uuid FOR UPDATE`;
      if (!batch) throw AppException.notFound(ErrorCode.BATCH_NOT_FOUND, 'Batch not found.');
      if (batch.generation_status !== 'COMPLETED')
        throw AppException.conflict(
          ErrorCode.BATCH_NOT_GENERATED,
          'Generate the batch before marking it printed.',
        );
      if (batch.print_status === 'PRINTED')
        throw AppException.conflict(
          ErrorCode.BATCH_ALREADY_PRINTED,
          'Batch is already marked printed.',
        );
      const moved = await tx.safetyId.updateMany({
        where: { batchId: id, status: 'GENERATED' },
        data: { status: 'PRINTED' },
      });
      const purged = await tx.safetyIdActivationSecret.deleteMany({
        where: { safetyIdRef: { batchId: id } },
      });
      await tx.safetyIdBatch.update({
        where: { id },
        data: { printStatus: 'PRINTED', printedAt: new Date() },
      });
      await this.audit.record(
        {
          action: AuditAction.SAFETY_ID_BATCH_PRINTED,
          entityType: 'safety_id_batch',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: {
            batchCode: batch.batch_code,
            safetyIdsPrinted: moved.count,
            pinsPurged: purged.count,
          },
        },
        tx,
      );
    });
    return this.get(id);
  }

  private toDto(
    b: Row,
    pinsEscrowed: number,
    exports: { count: number; lastAt: Date | null } = { count: 0, lastAt: null },
  ): SafetyIdBatchDto {
    return {
      id: b.id,
      batchCode: b.batchCode,
      mode: b.mode,
      helmetBatch: b.helmetBatch
        ? { id: b.helmetBatch.id, batchCode: b.helmetBatch.batchCode }
        : null,
      quantity: b.quantity,
      generatedCount: b.generatedCount,
      generationStatus: b.generationStatus,
      generationError: b.generationError,
      generationStartedAt: b.generationStartedAt?.toISOString() ?? null,
      generationCompletedAt: b.generationCompletedAt?.toISOString() ?? null,
      printStatus: b.printStatus,
      printedAt: b.printedAt?.toISOString() ?? null,
      pinsEscrowed,
      printDesign: b.printDesign,
      exportCount: exports.count,
      lastExportedAt: exports.lastAt?.toISOString() ?? null,
      notes: b.notes,
      createdBy: b.creator,
      createdAt: b.createdAt.toISOString(),
    };
  }

  private async escrowCounts(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ batch_id: string; n: bigint }[]>`
      SELECT s.batch_id, count(*)::bigint AS n FROM safety_id_activation_secrets e
      JOIN safety_ids s ON s.id = e.safety_id
      WHERE s.batch_id = ANY(${ids}::uuid[]) GROUP BY s.batch_id`;
    return new Map(rows.map((r) => [r.batch_id, Number(r.n)]));
  }

  private async exportHistory(
    ids: string[],
  ): Promise<Map<string, { count: number; lastAt: Date | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.auditLog.groupBy({
      by: ['entityId'],
      where: {
        action: { in: EXPORT_ACTIONS },
        entityType: 'safety_id_batch',
        entityId: { in: ids },
      },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return new Map(
      rows.map((r) => [r.entityId as string, { count: r._count._all, lastAt: r._max.createdAt }]),
    );
  }

  private async stats(batchId: string): Promise<SafetyIdBatchStatsDto> {
    const rows = await this.prisma.safetyId.groupBy({
      by: ['status'],
      where: { batchId },
      _count: { _all: true },
    });
    const n = (...s: string[]) =>
      rows.filter((r) => s.includes(r.status)).reduce((a, r) => a + r._count._all, 0);
    const generated = rows.reduce((a, r) => a + r._count._all, 0);
    const activated = await this.prisma.safetyId.count({
      where: { batchId, activatedAt: { not: null } },
    });
    return {
      generated,
      printed: generated - n('GENERATED'),
      activated,
      active: n('ACTIVE'),
      remaining: generated - activated,
    };
  }
}
