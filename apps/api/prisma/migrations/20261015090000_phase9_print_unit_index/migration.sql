-- Phase 9 final print: deterministic unit order within a Safety ID batch.
-- Additive only. New rows get unit_index at generation (batch offset + position, 1-based).
ALTER TABLE "safety_ids" ADD COLUMN "unit_index" INTEGER;

-- Backfill existing batch rows in the order exports used until now (id ascending), so a batch
-- exported before this release keeps the same row order.
UPDATE "safety_ids" s
SET "unit_index" = o.n
FROM (
  SELECT id, row_number() OVER (PARTITION BY batch_id ORDER BY id) AS n
  FROM "safety_ids"
  WHERE batch_id IS NOT NULL
) o
WHERE s.id = o.id AND s."unit_index" IS NULL;

CREATE UNIQUE INDEX "safety_ids_batch_id_unit_index_key" ON "safety_ids"("batch_id", "unit_index");
