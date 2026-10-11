import { Prisma } from '@prisma/client';
import type { BatchDto } from '@helmet/types';

export const batchInclude = {
  helmetModel: { select: { id: true, name: true, sku: true } },
  creator: { select: { id: true, name: true } },
  safetyIdBatches: {
    where: { mode: 'HELMET_LINKED' },
    orderBy: { createdAt: 'asc' },
    take: 1,
    select: { id: true, batchCode: true },
  },
} satisfies Prisma.HelmetBatchInclude;

export type BatchRow = Prisma.HelmetBatchGetPayload<{ include: typeof batchInclude }>;

export function toBatchDto(
  b: BatchRow,
  pinsEscrowed: number,
  exports: { count: number; lastAt: Date | null } = { count: 0, lastAt: null },
): BatchDto {
  return {
    id: b.id,
    batchCode: b.batchCode,
    helmetModel: b.helmetModel,
    manufacturingDate: b.manufacturingDate.toISOString().slice(0, 10),
    quantity: b.quantity,
    generatedCount: b.generatedCount,
    generationStatus: b.generationStatus,
    generationError: b.generationError,
    generationStartedAt: b.generationStartedAt?.toISOString() ?? null,
    generationCompletedAt: b.generationCompletedAt?.toISOString() ?? null,
    printStatus: b.printStatus,
    printedAt: b.printedAt?.toISOString() ?? null,
    pinsEscrowed,
    exportCount: exports.count,
    lastExportedAt: exports.lastAt?.toISOString() ?? null,
    withSafetyIds: b.withSafetyIds,
    safetyIdBatch: b.safetyIdBatches[0] ?? null,
    notes: b.notes,
    createdBy: b.creator,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}
