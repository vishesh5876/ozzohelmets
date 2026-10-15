import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ActorType,
  type BatchDto,
  type BatchStatsDto,
  ErrorCode,
  HelmetStatus,
} from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { buildMeta } from '../../common/dto/pagination.dto';
import { PaginatedResult } from '../../common/http/api-response.interceptor';
import { AppException } from '../../common/http/app.exception';
import type { RequestMeta } from '../../common/utils/request-context';
import { isUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { AuthenticatedAdmin } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import { HelmetStatusService } from '../helmets/domain/helmet-status.service';
import { batchInclude, toBatchDto } from './batch.mapper';
import { BatchGenerationService, STALE_GENERATION_MS } from './batch-generation.service';
import type { BatchQueryDto, CreateBatchDto } from './dto/batch.dto';

@Injectable()
export class BatchesService {
  private readonly logger = new Logger(BatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly generator: BatchGenerationService,
    private readonly statuses: HelmetStatusService,
  ) {}

  async list(query: BatchQueryDto): Promise<PaginatedResult<BatchDto>> {
    const where: Prisma.HelmetBatchWhereInput = {
      helmetModelId: query.helmetModelId,
      generationStatus: query.generationStatus,
      printStatus: query.printStatus,
      ...(query.manufacturedFrom || query.manufacturedTo
        ? {
            manufacturingDate: {
              ...(query.manufacturedFrom ? { gte: new Date(query.manufacturedFrom) } : {}),
              ...(query.manufacturedTo ? { lte: new Date(query.manufacturedTo) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { batchCode: { contains: query.search, mode: 'insensitive' } },
              { helmetModel: { name: { contains: query.search, mode: 'insensitive' } } },
              { helmetModel: { sku: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.helmetBatch.findMany({
        where,
        include: batchInclude,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.pageSize,
      }),
      this.prisma.helmetBatch.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const [escrow, exports] = await Promise.all([this.escrowCounts(ids), this.exportHistory(ids)]);
    return new PaginatedResult(
      rows.map((r) => toBatchDto(r, escrow.get(r.id) ?? 0, exports.get(r.id))),
      buildMeta(query.page, query.pageSize, total),
    );
  }

  async get(id: string): Promise<BatchDto> {
    const row = await this.prisma.helmetBatch.findUnique({ where: { id }, include: batchInclude });
    if (!row) throw AppException.notFound(ErrorCode.BATCH_NOT_FOUND, 'Batch not found.');
    const [escrow, exports, stats] = await Promise.all([
      this.escrowCounts([id]),
      this.exportHistory([id]),
      this.stats(id),
    ]);
    return { ...toBatchDto(row, escrow.get(id) ?? 0, exports.get(id)), stats };
  }

  async create(
    dto: CreateBatchDto,
    admin: AuthenticatedAdmin,
    meta: RequestMeta,
  ): Promise<BatchDto> {
    const max = this.config.get('BATCH_MAX_QUANTITY');
    if (dto.quantity > max) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        `Quantity cannot exceed ${max}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const model = await this.prisma.helmetModel.findUnique({
      where: { id: dto.helmetModelId },
      select: { status: true },
    });
    if (!model)
      throw AppException.notFound(ErrorCode.HELMET_MODEL_NOT_FOUND, 'Helmet model not found.');
    if (model.status !== 'ACTIVE') {
      throw AppException.conflict(
        ErrorCode.HELMET_MODEL_ARCHIVED,
        'Cannot create batches for an archived model.',
      );
    }
    const manufacturingDate = new Date(`${dto.manufacturingDate.slice(0, 10)}T00:00:00.000Z`);

    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const batchCode =
          dto.batchCode ?? (await this.nextBatchCode(tx, manufacturingDate.getUTCFullYear()));
        const withSafetyIds = dto.withSafetyIds ?? true;
        const row = await tx.helmetBatch.create({
          data: {
            batchCode,
            helmetModelId: dto.helmetModelId,
            manufacturingDate,
            quantity: dto.quantity,
            notes: dto.notes,
            withSafetyIds,
            createdBy: admin.id,
          },
          select: { id: true },
        });
        // Companion Safety ID batch: generated in the same chunks as the helmets.
        if (withSafetyIds) await this.createCompanion(tx, row.id, dto.quantity, admin.id);
        await this.audit.record(
          {
            action: AuditAction.BATCH_CREATED,
            entityType: 'batch',
            entityId: row.id,
            adminId: admin.id,
            ipHash: meta.ipHash,
            metadata: {
              batchCode,
              quantity: dto.quantity,
              helmetModelId: dto.helmetModelId,
              withSafetyIds: dto.withSafetyIds ?? true,
            },
          },
          tx,
        );
        return row.id;
      });
      return this.get(id);
    } catch (err) {
      if (isUniqueViolation(err))
        throw AppException.conflict(ErrorCode.CONFLICT, 'Batch code already exists.');
      throw err;
    }
  }

  /**
   * Claims the batch for generation (atomic; safe across API instances) and starts the job in
   * the background. Also used to resume FAILED or abandoned generations.
   */
  async startGeneration(
    id: string,
    admin: AuthenticatedAdmin,
    meta: RequestMeta,
  ): Promise<BatchDto> {
    const staleCutoff = new Date(Date.now() - STALE_GENERATION_MS);
    const claimed = await this.prisma.helmetBatch.updateMany({
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
      if (batch.generationStatus === 'GENERATING') {
        throw AppException.conflict(
          ErrorCode.BATCH_GENERATION_IN_PROGRESS,
          'Generation is already in progress.',
        );
      }
      throw AppException.conflict(
        ErrorCode.BATCH_ALREADY_GENERATED,
        'Helmets for this batch have already been generated.',
      );
    }
    // The companion Safety ID batch follows the helmet batch's generation state.
    const claimedRow = await this.prisma.helmetBatch.findUniqueOrThrow({
      where: { id },
      select: { withSafetyIds: true, quantity: true },
    });
    if (claimedRow.withSafetyIds) {
      const companion = await this.prisma.safetyIdBatch.findFirst({
        where: { helmetBatchId: id, mode: 'HELMET_LINKED' },
        select: { id: true },
      });
      if (!companion)
        await this.prisma.$transaction((tx) =>
          this.createCompanion(tx, id, claimedRow.quantity, admin.id),
        );
      await this.prisma.safetyIdBatch.updateMany({
        where: { helmetBatchId: id, mode: 'HELMET_LINKED', generationStatus: { not: 'COMPLETED' } },
        data: {
          generationStatus: 'GENERATING',
          generationStartedAt: new Date(),
          generationError: null,
        },
      });
    }
    const batch = await this.get(id);
    await this.audit.record({
      action: AuditAction.BATCH_GENERATION_STARTED,
      entityType: 'batch',
      entityId: id,
      adminId: admin.id,
      ipHash: meta.ipHash,
      metadata: {
        batchCode: batch.batchCode,
        quantity: batch.quantity,
        alreadyGenerated: batch.generatedCount,
      },
    });
    // Background job: progress is persisted on the batch and polled by the admin UI.
    void this.generator
      .run(id, admin.id)
      .catch((err: Error) => this.logger.error(`Generation job crashed: ${err.message}`));
    return batch;
  }

  /**
   * Confirms labels were printed: moves GENERATED helmets to PRINTED and permanently purges the
   * PIN escrow for the batch. After this, PINs can no longer be exported.
   */
  async markPrinted(id: string, admin: AuthenticatedAdmin, meta: RequestMeta): Promise<BatchDto> {
    this.statuses.assertTransition(HelmetStatus.GENERATED, HelmetStatus.PRINTED, ActorType.ADMIN);
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { generation_status: string; print_status: string; batch_code: string }[]
      >`
        SELECT generation_status, print_status, batch_code FROM helmet_batches WHERE id = ${id}::uuid FOR UPDATE`;
      const batch = locked[0];
      if (!batch) throw AppException.notFound(ErrorCode.BATCH_NOT_FOUND, 'Batch not found.');
      if (batch.generation_status !== 'COMPLETED') {
        throw AppException.conflict(
          ErrorCode.BATCH_NOT_GENERATED,
          'Generate all helmets before marking the batch printed.',
        );
      }
      if (batch.print_status === 'PRINTED') {
        throw AppException.conflict(
          ErrorCode.BATCH_ALREADY_PRINTED,
          'Batch is already marked printed.',
        );
      }

      await tx.$executeRaw`
        INSERT INTO helmet_status_history (id, helmet_id, from_status, to_status, actor_type, actor_id, reason, created_at)
        SELECT gen_random_uuid(), h.id, 'GENERATED'::"HelmetStatus", 'PRINTED'::"HelmetStatus", 'ADMIN'::"ActorType", ${admin.id}::uuid, 'Batch labels printed', now()
        FROM helmets h WHERE h.batch_id = ${id}::uuid AND h.status = 'GENERATED'::"HelmetStatus"`;
      const moved = await tx.helmet.updateMany({
        where: { batchId: id, status: 'GENERATED' },
        data: { status: 'PRINTED' },
      });
      const purgedHelmet = await tx.helmetActivationSecret.deleteMany({
        where: { helmet: { batchId: id } },
      });
      // Phase 9: the QR + PIN printed with these helmets belong to their linked Safety IDs.
      const linked = await this.safetyIdsForHelmetBatch(tx, id);
      const safetyMoved = await tx.safetyId.updateMany({
        where: { id: { in: linked }, status: 'GENERATED' },
        data: { status: 'PRINTED' },
      });
      const purgedSafety = await tx.safetyIdActivationSecret.deleteMany({
        where: { safetyId: { in: linked } },
      });
      const purged = { count: purgedHelmet.count + purgedSafety.count };
      await tx.safetyIdBatch.updateMany({
        where: { helmetBatchId: id, mode: 'HELMET_LINKED', printStatus: 'NOT_PRINTED' },
        data: { printStatus: 'PRINTED', printedAt: new Date() },
      });
      await tx.helmetBatch.update({
        where: { id },
        data: { printStatus: 'PRINTED', printedAt: new Date() },
      });

      await this.audit.record(
        {
          action: AuditAction.BATCH_MARKED_PRINTED,
          entityType: 'batch',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: {
            batchCode: batch.batch_code,
            helmetsPrinted: moved.count,
            safetyIdsPrinted: safetyMoved.count,
          },
        },
        tx,
      );
      await this.audit.record(
        {
          action: AuditAction.BATCH_PIN_ESCROW_PURGED,
          entityType: 'batch',
          entityId: id,
          adminId: admin.id,
          ipHash: meta.ipHash,
          metadata: { batchCode: batch.batch_code, pinsPurged: purged.count },
        },
        tx,
      );
    });
    return this.get(id);
  }

  private async createCompanion(
    tx: Prisma.TransactionClient,
    helmetBatchId: string,
    quantity: number,
    adminId: string,
  ): Promise<void> {
    const [row] = await tx.$queryRaw<
      { n: bigint }[]
    >`SELECT nextval('safety_id_batch_code_seq') AS n`;
    const batchCode = `SID-${new Date().getUTCFullYear()}-${String(row?.n ?? 0).padStart(5, '0')}`;
    // The companion batch binds the ACTIVE print design version (none = built-in layout).
    const design = await tx.printDesign.findFirst({
      where: { status: 'ACTIVE' },
      select: { id: true, version: true },
    });
    await tx.safetyIdBatch.create({
      data: {
        batchCode,
        mode: 'HELMET_LINKED',
        helmetBatchId,
        quantity,
        createdBy: adminId,
        printDesignId: design?.id ?? null,
        printDesignVersion: design?.version ?? null,
      },
    });
  }

  /** Safety IDs currently linked to helmets of a helmet batch. */
  private async safetyIdsForHelmetBatch(
    tx: Prisma.TransactionClient,
    helmetBatchId: string,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT l.safety_id AS id FROM safety_id_helmet_links l
      JOIN helmets h ON h.id = l.helmet_id
      WHERE h.batch_id = ${helmetBatchId}::uuid AND l.ended_at IS NULL`;
    return rows.map((r) => r.id);
  }

  /** BAT-<year>-<5-digit sequence>. The DB sequence guarantees no two batches get the same number. */
  private async nextBatchCode(tx: Prisma.TransactionClient, year: number): Promise<string> {
    const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('helmet_batch_code_seq') AS n`;
    return `BAT-${year}-${String(row?.n ?? 0).padStart(5, '0')}`;
  }

  private async escrowCounts(batchIds: string[]): Promise<Map<string, number>> {
    if (batchIds.length === 0) return new Map();
    // PINs printed with the helmets: escrow of their linked Safety IDs (Phase 9). Migrated
    // Safety IDs carry a copy of the Phase 8 helmet escrow, so this counts every printable PIN.
    const rows = await this.prisma.$queryRaw<{ batch_id: string; n: bigint }[]>`
      SELECT h.batch_id, COUNT(*)::bigint AS n
      FROM safety_id_activation_secrets s
      JOIN safety_id_helmet_links l ON l.safety_id = s.safety_id AND l.ended_at IS NULL
      JOIN helmets h ON h.id = l.helmet_id
      WHERE h.batch_id = ANY(${batchIds}::uuid[])
      GROUP BY h.batch_id`;
    return new Map(rows.map((r) => [r.batch_id, Number(r.n)]));
  }

  /** Manufacturing CSV exports per batch, from the audit log (no extra columns needed). */
  private async exportHistory(
    batchIds: string[],
  ): Promise<Map<string, { count: number; lastAt: Date | null }>> {
    if (batchIds.length === 0) return new Map();
    const rows = await this.prisma.auditLog.groupBy({
      by: ['entityId'],
      where: {
        action: AuditAction.BATCH_EXPORT_MANUFACTURING_CSV,
        entityType: 'helmet_batch',
        entityId: { in: batchIds },
      },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    return new Map(
      rows.map((r) => [r.entityId as string, { count: r._count._all, lastAt: r._max.createdAt }]),
    );
  }

  private async stats(batchId: string): Promise<BatchStatsDto> {
    const [byStatus, activated] = await Promise.all([
      this.prisma.helmet.groupBy({ by: ['status'], where: { batchId }, _count: { _all: true } }),
      this.prisma.helmet.count({ where: { batchId, activatedAt: { not: null } } }),
    ]);
    const count = (...statuses: string[]) =>
      byStatus.filter((r) => statuses.includes(r.status)).reduce((n, r) => n + r._count._all, 0);
    const generated = byStatus.reduce((n, r) => n + r._count._all, 0);
    return {
      generated,
      printed: generated - count('GENERATED'),
      activated,
      active: count('ACTIVE'),
      lostOrStolen: count('LOST', 'STOLEN'),
      remaining: generated - activated,
    };
  }
}
