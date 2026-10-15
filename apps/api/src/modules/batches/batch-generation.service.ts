import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActorType, HelmetStatus } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { buildSerialNumber, generateHelmetCode } from '../../security/helmet-identity.generator';
import { uuidv7 } from '../../security/uuid';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';
import {
  freshIdentifiers,
  isIdentifierCollision,
  MAX_COLLISION_RETRIES,
  SafetyIdGenerationService,
} from '../safety-ids/generation/safety-id-generation.service';

/** A GENERATING batch whose heartbeat (updated_at) is older than this is considered abandoned. */
export const STALE_GENERATION_MS = 5 * 60_000;

interface PreparedUnit {
  id: string;
  serialNumber: string;
}

/**
 * Generates helmet identities for a batch in chunks. Each chunk is one transaction that inserts
 * helmets, status history and (Phase 9, when enabled) their linked Safety IDs with PIN escrow, and advances `generated_count` with an
 * optimistic check — so the job is resumable after a crash and cannot double-generate.
 */
@Injectable()
export class BatchGenerationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BatchGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly safetyIds: SafetyIdGenerationService,
  ) {}

  /** Marks batches abandoned by a crashed/restarted process as FAILED so they can be resumed. */
  async onApplicationBootstrap(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_GENERATION_MS);
    const { count } = await this.prisma.helmetBatch.updateMany({
      where: { generationStatus: 'GENERATING', updatedAt: { lt: cutoff } },
      data: {
        generationStatus: 'FAILED',
        generationError: 'Generation was interrupted. Resume to continue.',
      },
    });
    if (count > 0) this.logger.warn(`Marked ${count} interrupted batch generation(s) as FAILED`);
  }

  /** Runs to completion; never throws (failures are persisted on the batch). */
  async run(batchId: string, startedBy: string | null): Promise<void> {
    const started = Date.now();
    try {
      for (;;) {
        const batch = await this.prisma.helmetBatch.findUniqueOrThrow({
          where: { id: batchId },
          select: {
            batchCode: true,
            helmetModelId: true,
            quantity: true,
            generatedCount: true,
            generationStatus: true,
            withSafetyIds: true,
            safetyIdBatches: {
              where: { mode: 'HELMET_LINKED' },
              select: { id: true },
              take: 1,
            },
          },
        });
        if (batch.generationStatus !== 'GENERATING') {
          this.logger.warn(`Batch ${batch.batchCode} left GENERATING state; stopping`);
          return;
        }
        const remaining = batch.quantity - batch.generatedCount;
        if (remaining <= 0) break;
        const size = Math.min(this.config.get('BATCH_GENERATION_CHUNK_SIZE'), remaining);
        await this.generateChunk(
          batchId,
          batch.batchCode,
          batch.helmetModelId,
          batch.generatedCount,
          size,
          batch.withSafetyIds ? (batch.safetyIdBatches[0]?.id ?? null) : null,
        );
        this.logger.log(
          `Batch ${batch.batchCode}: ${batch.generatedCount + size}/${batch.quantity}`,
        );
      }

      const done = await this.prisma.helmetBatch.update({
        where: { id: batchId },
        data: {
          generationStatus: 'COMPLETED',
          generationCompletedAt: new Date(),
          generationError: null,
        },
        select: { batchCode: true, quantity: true },
      });
      await this.prisma.safetyIdBatch.updateMany({
        where: { helmetBatchId: batchId, mode: 'HELMET_LINKED', generationStatus: 'GENERATING' },
        data: { generationStatus: 'COMPLETED', generationCompletedAt: new Date() },
      });
      await this.audit.recordSafe({
        action: AuditAction.BATCH_GENERATION_COMPLETED,
        entityType: 'batch',
        entityId: batchId,
        adminId: startedBy,
        metadata: {
          batchCode: done.batchCode,
          quantity: done.quantity,
          durationMs: Date.now() - started,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Batch ${batchId} generation failed: ${message}`);
      await this.prisma.helmetBatch
        .update({
          where: { id: batchId },
          data: {
            generationStatus: 'FAILED',
            generationError: 'Generation failed. Resume to retry.',
          },
        })
        .catch(() => undefined);
      await this.prisma.safetyIdBatch
        .updateMany({
          where: { helmetBatchId: batchId, mode: 'HELMET_LINKED', generationStatus: 'GENERATING' },
          data: { generationStatus: 'FAILED', generationError: 'Helmet batch generation failed.' },
        })
        .catch(() => undefined);
      await this.audit.recordSafe({
        action: AuditAction.BATCH_GENERATION_FAILED,
        entityType: 'batch',
        entityId: batchId,
        adminId: startedBy,
        metadata: { error: message.slice(0, 300) },
      });
    }
  }

  /**
   * One chunk = one transaction. With `safetyBatchId` every helmet gets its own linked Safety ID
   * (QR token + Activation PIN, escrowed under the Safety ID) and the helmet mirrors that token and
   * PIN hash for rollback compatibility. Without it, helmets carry no QR (a Safety ID can be
   * generated for them later).
   */
  private async generateChunk(
    batchId: string,
    batchCode: string,
    helmetModelId: string,
    offset: number,
    size: number,
    safetyBatchId: string | null,
  ): Promise<void> {
    const units = this.prepareUnits(batchCode, offset, size);
    const safety = safetyBatchId ? (await this.safetyIds.prepare(size)).units : null;

    for (let attempt = 1; ; attempt++) {
      // Public identifiers are regenerated on every attempt; ids/PINs/serials are stable.
      const ids = units.map(() => freshIdentifiers());
      const helmets: Prisma.HelmetCreateManyInput[] = units.map((u, i) => ({
        id: u.id,
        helmetCode: generateHelmetCode(),
        publicToken: safety ? ids[i]!.publicToken : null,
        activationPinHash: safety ? safety[i]!.activationPinHash : null,
        serialNumber: u.serialNumber,
        helmetModelId,
        batchId,
        status: HelmetStatus.GENERATED,
      }));
      try {
        await this.prisma.$transaction(
          async (tx) => {
            const advanced = await tx.helmetBatch.updateMany({
              where: { id: batchId, generatedCount: offset, generationStatus: 'GENERATING' },
              data: { generatedCount: offset + size },
            });
            if (advanced.count !== 1) throw new Error('Batch progress changed concurrently');
            await tx.helmet.createMany({ data: helmets });
            await tx.helmetStatusHistory.createMany({
              data: units.map((u) => ({
                id: uuidv7(),
                helmetId: u.id,
                fromStatus: null,
                toStatus: HelmetStatus.GENERATED,
                actorType: ActorType.SYSTEM,
                reason: `Generated in batch ${batchCode}`,
              })),
            });
            if (safety && safetyBatchId) {
              await this.safetyIds.advance(tx, safetyBatchId, offset, size);
              await this.safetyIds.insert(
                tx,
                safetyBatchId,
                offset,
                safety,
                ids,
                units.map((u) => u.id),
              );
            }
          },
          { timeout: 60_000, maxWait: 10_000 },
        );
        return;
      } catch (err) {
        if (isIdentifierCollision(err) && attempt < MAX_COLLISION_RETRIES) {
          this.logger.warn(
            `Identifier collision in batch ${batchCode} (attempt ${attempt}); regenerating chunk`,
          );
          continue;
        }
        throw err;
      }
    }
  }

  private prepareUnits(batchCode: string, offset: number, size: number): PreparedUnit[] {
    return Array.from({ length: size }, (_, i) => ({
      id: uuidv7(),
      serialNumber: buildSerialNumber(batchCode, offset + i + 1),
    }));
  }
}
