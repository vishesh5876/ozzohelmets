-- Phase 9: helmet batches can generate one linked Safety ID per helmet (additive).
-- AlterTable
ALTER TABLE "helmet_batches" ADD COLUMN     "with_safety_ids" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "safety_id_batches_helmet_batch_id_idx" ON "safety_id_batches"("helmet_batch_id");

-- AddForeignKey
ALTER TABLE "safety_id_batches" ADD CONSTRAINT "safety_id_batches_helmet_batch_id_fkey" FOREIGN KEY ("helmet_batch_id") REFERENCES "helmet_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Batches created before Phase 9 but not generated yet get the Phase 9 default (one Safety ID per
-- helmet). Generated or partially generated batches keep their per-helmet QR (migrated to Safety IDs).
UPDATE "helmet_batches" SET "with_safety_ids" = true
WHERE "generation_status" = 'PENDING' AND "generated_count" = 0;
