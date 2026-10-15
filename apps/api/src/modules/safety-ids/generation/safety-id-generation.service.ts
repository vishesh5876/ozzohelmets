import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../../../config/app-config.service';
import { mapWithConcurrency } from '../../../common/utils/concurrency';
import { isUniqueViolation } from '../../../infrastructure/prisma/prisma-errors';
import { PrismaService, type PrismaTx } from '../../../infrastructure/prisma/prisma.service';
import { EncryptionService } from '../../../security/encryption.service';
import { HashingService } from '../../../security/hashing.service';
import {
  generatePublicToken,
  generateSafetyIdPin,
  generateSafetyCode,
} from '../../../security/helmet-identity.generator';
import { uuidv7 } from '../../../security/uuid';
import { AuditService } from '../../audit/audit.service';
import { AuditAction } from '../../audit/audit-actions';

/** A GENERATING batch whose heartbeat (updated_at) is older than this is considered abandoned. */
export const STALE_SAFETY_GENERATION_MS = 5 * 60_000;
export const MAX_COLLISION_RETRIES = 5;
/** Argon2 runs on the libuv threadpool (default 4 threads); leave headroom for other work. */
const HASH_CONCURRENCY = 3;

/** A Safety ID before insertion. The plaintext PIN never leaves `prepare()`. */
export interface PreparedSafetyId {
  id: string;
  activationPinHash: string;
  pinCiphertext: string;
}

/** Public identifiers, regenerated on every insert attempt (unique-collision retry). */
export interface SafetyIdIdentifiers {
  safetyCode: string;
  publicToken: string;
}

export function freshIdentifiers(): SafetyIdIdentifiers {
  return { safetyCode: generateSafetyCode(), publicToken: generatePublicToken() };
}

export function isIdentifierCollision(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const target = JSON.stringify(err.meta?.target ?? '');
  return [
    'safety_code',
    'public_token',
    'helmet_code',
    'safetyCode',
    'publicToken',
    'helmetCode',
  ].some((t) => target.includes(t));
}

/**
 * Generates Safety IDs in chunks. Each chunk is one transaction that inserts Safety IDs, their
 * PIN escrow and (helmet-linked mode) the links, and advances `generated_count` with an
 * optimistic check — so the job is resumable after a crash and cannot double-generate.
 * Hashing goes through the shared Argon2 limiter (HashingService), never more than
 * HASH_CONCURRENCY at a time, so a 5 000-unit batch can't starve activation or sign-in.
 */
@Injectable()
export class SafetyIdGenerationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SafetyIdGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  /** Marks batches abandoned by a crashed/restarted process as FAILED so they can be resumed. */
  async onApplicationBootstrap(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_SAFETY_GENERATION_MS);
    // Single-table update (no join): a companion batch of a helmet batch is reset to GENERATING
    // again when its helmet batch generation is resumed.
    const { count } = await this.prisma.safetyIdBatch.updateMany({
      where: { generationStatus: 'GENERATING', updatedAt: { lt: cutoff } },
      data: {
        generationStatus: 'FAILED',
        generationError: 'Generation was interrupted. Resume to continue.',
      },
    });
    if (count > 0)
      this.logger.warn(`Marked ${count} interrupted Safety ID generation(s) as FAILED`);
  }

  /**
   * Six-digit PIN (string) → Argon2id hash with the PIN pepper (verification) + AES-GCM escrow
   * bound to the Safety ID id (printing). The plaintext exists only inside this function.
   */
  async prepare(size: number): Promise<{ units: PreparedSafetyId[] }> {
    const units = await mapWithConcurrency(
      Array.from({ length: size }, (_, i) => i),
      HASH_CONCURRENCY,
      async () => {
        const id = uuidv7();
        const pin = generateSafetyIdPin();
        return {
          id,
          activationPinHash: await this.hashing.hashPin(pin),
          pinCiphertext: this.encryption.pinEscrow.encrypt(pin, id),
        };
      },
    );
    return { units };
  }

  /**
   * Inserts prepared Safety IDs (and links, when `helmetIds` is given — same order as `units`)
   * inside the caller's transaction. `offset` is the batch's generated count before this chunk;
   * unit N of the batch gets `unit_index` N (the deterministic print order). A linked helmet mirrors the Safety ID's public token and
   * PIN hash, so a Phase 8 rollback can still resolve and activate it.
   */
  async insert(
    tx: PrismaTx,
    batchId: string,
    offset: number,
    units: PreparedSafetyId[],
    ids: SafetyIdIdentifiers[],
    helmetIds?: string[],
    linkReason = 'GENERATED_WITH_HELMET',
  ): Promise<void> {
    await tx.safetyId.createMany({
      data: units.map((u, i) => ({
        id: u.id,
        safetyCode: ids[i]!.safetyCode,
        publicToken: ids[i]!.publicToken,
        status: 'GENERATED',
        activationPinHash: u.activationPinHash,
        batchId,
        // 1-based, contiguous per batch: the print/export order.
        unitIndex: offset + i + 1,
      })),
    });
    await tx.safetyIdActivationSecret.createMany({
      data: units.map((u) => ({ safetyId: u.id, pinCiphertext: u.pinCiphertext })),
    });
    if (helmetIds) {
      const now = new Date();
      await tx.safetyIdHelmetLink.createMany({
        data: units.map((u, i) => ({
          id: uuidv7(),
          safetyId: u.id,
          helmetId: helmetIds[i]!,
          reason: linkReason,
          startedAt: now,
        })),
      });
      // Rollback compatibility: helmets carry the same token/hash (only where none is set).
      for (let i = 0; i < units.length; i++)
        await tx.helmet.updateMany({
          where: { id: helmetIds[i]!, publicToken: null },
          data: {
            publicToken: ids[i]!.publicToken,
            activationPinHash: units[i]!.activationPinHash,
          },
        });
    }
  }

  /** Runs to completion; never throws (failures are persisted on the batch). */
  async run(batchId: string, startedBy: string | null): Promise<void> {
    const started = Date.now();
    try {
      for (;;) {
        const batch = await this.prisma.safetyIdBatch.findUniqueOrThrow({
          where: { id: batchId },
          select: {
            batchCode: true,
            mode: true,
            helmetBatchId: true,
            quantity: true,
            generatedCount: true,
            generationStatus: true,
          },
        });
        if (batch.generationStatus !== 'GENERATING') {
          this.logger.warn(`Safety ID batch ${batch.batchCode} left GENERATING state; stopping`);
          return;
        }
        const remaining = batch.quantity - batch.generatedCount;
        if (remaining <= 0) break;
        const size = Math.min(this.config.get('BATCH_GENERATION_CHUNK_SIZE'), remaining);
        const made =
          batch.mode === 'STANDALONE'
            ? await this.standaloneChunk(batchId, batch.generatedCount, size)
            : await this.linkedChunk(batchId, batch.helmetBatchId!, batch.generatedCount, size);
        if (made === 0) {
          // Helmet-linked: fewer helmets left without a Safety ID than planned (e.g. some were
          // linked manually meanwhile). Close the batch at what was actually generated.
          await this.prisma.safetyIdBatch.update({
            where: { id: batchId },
            data: { quantity: batch.generatedCount },
          });
          break;
        }
        this.logger.log(
          `Safety ID batch ${batch.batchCode}: ${batch.generatedCount + made}/${batch.quantity}`,
        );
      }
      const done = await this.prisma.safetyIdBatch.update({
        where: { id: batchId },
        data: {
          generationStatus: 'COMPLETED',
          generationCompletedAt: new Date(),
          generationError: null,
        },
        select: { batchCode: true, quantity: true, mode: true },
      });
      await this.audit.recordSafe({
        action: AuditAction.SAFETY_ID_BATCH_GENERATED,
        entityType: 'safety_id_batch',
        entityId: batchId,
        adminId: startedBy,
        metadata: {
          batchCode: done.batchCode,
          mode: done.mode,
          quantity: done.quantity,
          durationMs: Date.now() - started,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Safety ID batch ${batchId} generation failed: ${message}`);
      await this.prisma.safetyIdBatch
        .update({
          where: { id: batchId },
          data: {
            generationStatus: 'FAILED',
            generationError: 'Generation failed. Resume to retry.',
          },
        })
        .catch(() => undefined);
    }
  }

  private async standaloneChunk(batchId: string, offset: number, size: number): Promise<number> {
    const { units } = await this.prepare(size);
    await this.withRetry(async (ids) => {
      await this.prisma.$transaction(
        async (tx) => {
          await this.advance(tx, batchId, offset, size);
          await this.insert(tx, batchId, offset, units, ids);
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
    }, size);
    return size;
  }

  /** One Safety ID for each next helmet of the helmet batch that has no current link. */
  private async linkedChunk(
    batchId: string,
    helmetBatchId: string,
    offset: number,
    size: number,
  ): Promise<number> {
    const helmets = await this.helmetsWithoutSafetyId(this.prisma, helmetBatchId, size);
    if (helmets.length === 0) return 0;
    const { units } = await this.prepare(helmets.length);
    await this.withRetry(async (ids) => {
      await this.prisma.$transaction(
        async (tx) => {
          await this.advance(tx, batchId, offset, helmets.length);
          // Re-check under the batch lock: still unlinked (partial unique index backs this up).
          const still = await this.helmetsWithoutSafetyId(tx, helmetBatchId, size);
          if (still.length !== helmets.length || still.some((h, i) => h !== helmets[i]))
            throw new Error('Helmet links changed concurrently');
          await this.insert(tx, batchId, offset, units, ids, helmets, 'GENERATED_FOR_HELMET');
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
    }, helmets.length);
    return helmets.length;
  }

  async helmetsWithoutSafetyId(
    db: PrismaTx,
    helmetBatchId: string,
    limit: number,
  ): Promise<string[]> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT h.id FROM helmets h
      WHERE h.batch_id = ${helmetBatchId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM safety_id_helmet_links l WHERE l.helmet_id = h.id AND l.ended_at IS NULL)
        AND h.status NOT IN ('REPLACED'::"HelmetStatus", 'DEACTIVATED'::"HelmetStatus")
      ORDER BY h.id LIMIT ${limit}`;
    return rows.map((r) => r.id);
  }

  async countHelmetsWithoutSafetyId(helmetBatchId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM helmets h
      WHERE h.batch_id = ${helmetBatchId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM safety_id_helmet_links l WHERE l.helmet_id = h.id AND l.ended_at IS NULL)
        AND h.status NOT IN ('REPLACED'::"HelmetStatus", 'DEACTIVATED'::"HelmetStatus")`;
    return Number(row?.n ?? 0);
  }

  /** Optimistic progress step: fails if another runner advanced the same batch. */
  async advance(tx: PrismaTx, batchId: string, offset: number, size: number): Promise<void> {
    const advanced = await tx.safetyIdBatch.updateMany({
      where: { id: batchId, generatedCount: offset, generationStatus: 'GENERATING' },
      data: { generatedCount: offset + size },
    });
    if (advanced.count !== 1) throw new Error('Safety ID batch progress changed concurrently');
  }

  /** Retries a chunk with fresh public identifiers on a (vanishingly rare) unique collision. */
  async withRetry(fn: (ids: SafetyIdIdentifiers[]) => Promise<void>, size: number): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await fn(Array.from({ length: size }, freshIdentifiers));
        return;
      } catch (err) {
        if (isIdentifierCollision(err) && attempt < MAX_COLLISION_RETRIES) {
          this.logger.warn(`Safety ID identifier collision (attempt ${attempt}); regenerating`);
          continue;
        }
        throw err;
      }
    }
  }
}
