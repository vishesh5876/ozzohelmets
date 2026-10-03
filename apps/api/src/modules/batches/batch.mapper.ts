import { Prisma } from '@prisma/client';
import type { BatchDto } from '@helmet/types';

export const batchInclude = {
  helmetModel: { select: { id: true, name: true, sku: true } },
  creator: { select: { id: true, name: true } },
} satisfies Prisma.HelmetBatchInclude;

export type BatchRow = Prisma.HelmetBatchGetPayload<{ include: typeof batchInclude }>;

export function toBatchDto(b: BatchRow, pinsEscrowed: number): BatchDto {
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
    notes: b.notes,
    createdBy: b.creator,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}
