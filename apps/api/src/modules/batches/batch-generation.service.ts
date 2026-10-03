import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActorType, HelmetStatus } from '@helmet/types';
import { AppConfigService } from '../../config/app-config.service';
import { mapWithConcurrency } from '../../common/utils/concurrency';
import { isUniqueViolation } from '../../infrastructure/prisma/prisma-errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { EncryptionService } from '../../security/encryption.service';
import { HashingService } from '../../security/hashing.service';
import {
  buildSerialNumber,
  generateActivationPin,
  generateHelmetCode,
  generatePublicToken,
} from '../../security/helmet-identity.generator';
import { uuidv7 } from '../../security/uuid';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit-actions';

/** A GENERATING batch whose heartbeat (updated_at) is older than this is considered abandoned. */
export const STALE_GENERATION_MS = 5 * 60_000;
const MAX_COLLISION_RETRIES = 5;
/** Argon2 runs on the libuv threadpool (default 4 threads); leave headroom for other work. */
const HASH_CONCURRENCY = 3;

interface PreparedUnit {
  id: string;
  serialNumber: string;
  activationPinHash: string;
  pinCiphertext: string;
}

/**
 * Generates helmet identities for a batch in chunks. Each chunk is one transaction that inserts
 * helmets, PIN escrow rows and status history, and advances `generated_count` with an
 * optimistic check — so the job is resumable after a crash and cannot double-generate.
 */
@Injectable()
export class BatchGenerationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BatchGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
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
      await this.audit.recordSafe({
        action: AuditAction.BATCH_GENERATION_FAILED,
        entityType: 'batch',
        entityId: batchId,
        adminId: startedBy,
        metadata: { error: message.slice(0, 300) },
      });
    }
  }

  private async generateChunk(
    batchId: string,
    batchCode: string,
    helmetModelId: string,
    offset: number,
    size: number,
  ): Promise<void> {
    const units = await this.prepareUnits(batchCode, offset, size);

    for (let attempt = 1; ; attempt++) {
      // Public identifiers are regenerated on every attempt; ids/PINs/serials are stable.
      const helmets: Prisma.HelmetCreateManyInput[] = units.map((u) => ({
        id: u.id,
        helmetCode: generateHelmetCode(),
        publicToken: generatePublicToken(),
        activationPinHash: u.activationPinHash,
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
            await tx.helmetActivationSecret.createMany({
              data: units.map((u) => ({ helmetId: u.id, pinCiphertext: u.pinCiphertext })),
            });
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
          },
          { timeout: 60_000, maxWait: 10_000 },
        );
        return;
      } catch (err) {
        const target = isUniqueViolation(err) ? JSON.stringify(err.meta?.target ?? '') : '';
        const identifierCollision =
          target.includes('helmet_code') ||
          target.includes('public_token') ||
          target.includes('helmetCode') ||
          target.includes('publicToken');
        if (identifierCollision && attempt < MAX_COLLISION_RETRIES) {
          this.logger.warn(
            `Identifier collision in batch ${batchCode} (attempt ${attempt}); regenerating chunk`,
          );
          continue;
        }
        throw err;
      }
    }
  }

  private async prepareUnits(
    batchCode: string,
    offset: number,
    size: number,
  ): Promise<PreparedUnit[]> {
    const indices = Array.from({ length: size }, (_, i) => offset + i + 1);
    return mapWithConcurrency(indices, HASH_CONCURRENCY, async (unitIndex) => {
      const id = uuidv7();
      // The plaintext PIN exists only in this closure: hashed for verification, encrypted
      // (bound to the helmet id) for the time-limited manufacturing escrow.
      const pin = generateActivationPin();
      const activationPinHash = await this.hashing.hashPin(pin);
      const pinCiphertext = this.encryption.pinEscrow.encrypt(pin, id);
      return {
        id,
        serialNumber: buildSerialNumber(batchCode, unitIndex),
        activationPinHash,
        pinCiphertext,
      };
    });
  }
}
