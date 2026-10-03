-- CreateEnum
CREATE TYPE "OwnershipAcquisition" AS ENUM ('ACTIVATION', 'TRANSFER');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'CLAIMED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReplacementReason" AS ENUM ('DAMAGED', 'DEFECTIVE', 'ACCIDENT', 'SUPPORT_REPLACEMENT', 'OTHER');

-- DropIndex
DROP INDEX "helmet_ownerships_helmet_id_idx";

-- DropIndex
DROP INDEX "helmet_ownerships_user_id_idx";

-- AlterTable
ALTER TABLE "helmet_ownerships" ADD COLUMN     "acquired_via" "OwnershipAcquisition" NOT NULL DEFAULT 'ACTIVATION',
ADD COLUMN     "end_reason" VARCHAR(60),
ADD COLUMN     "ended_at" TIMESTAMPTZ(3),
ADD COLUMN     "ended_by_admin_id" UUID,
ADD COLUMN     "transfer_id" UUID;

-- AlterTable
ALTER TABLE "helmet_status_history" ADD COLUMN     "reason_code" VARCHAR(60);

-- AlterTable
ALTER TABLE "helmets" ADD COLUMN     "previous_operational_status" "HelmetStatus";

-- CreateTable
CREATE TABLE "helmet_emergency_settings" (
    "id" UUID NOT NULL,
    "helmet_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helmet_emergency_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helmet_transfers" (
    "id" UUID NOT NULL,
    "helmet_id" UUID NOT NULL,
    "from_user_id" UUID NOT NULL,
    "to_user_id" UUID,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "code_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "claimed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" VARCHAR(60),
    "cancelled_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helmet_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helmet_replacements" (
    "id" UUID NOT NULL,
    "original_helmet_id" UUID NOT NULL,
    "replacement_helmet_id" UUID NOT NULL,
    "reason" "ReplacementReason" NOT NULL,
    "notes" VARCHAR(500),
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helmet_replacements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "helmet_emergency_settings_user_id_idx" ON "helmet_emergency_settings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "helmet_emergency_settings_helmet_id_user_id_key" ON "helmet_emergency_settings"("helmet_id", "user_id");

-- CreateIndex
CREATE INDEX "helmet_transfers_helmet_id_created_at_idx" ON "helmet_transfers"("helmet_id", "created_at");

-- CreateIndex
CREATE INDEX "helmet_transfers_from_user_id_idx" ON "helmet_transfers"("from_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "helmet_replacements_original_helmet_id_key" ON "helmet_replacements"("original_helmet_id");

-- CreateIndex
CREATE UNIQUE INDEX "helmet_replacements_replacement_helmet_id_key" ON "helmet_replacements"("replacement_helmet_id");

-- CreateIndex
CREATE INDEX "helmet_ownerships_helmet_id_activated_at_idx" ON "helmet_ownerships"("helmet_id", "activated_at");

-- CreateIndex
CREATE INDEX "helmet_ownerships_user_id_status_idx" ON "helmet_ownerships"("user_id", "status");

-- AddForeignKey
ALTER TABLE "helmet_emergency_settings" ADD CONSTRAINT "helmet_emergency_settings_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_emergency_settings" ADD CONSTRAINT "helmet_emergency_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_transfers" ADD CONSTRAINT "helmet_transfers_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_transfers" ADD CONSTRAINT "helmet_transfers_from_user_id_fkey" FOREIGN KEY ("from_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_transfers" ADD CONSTRAINT "helmet_transfers_to_user_id_fkey" FOREIGN KEY ("to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_replacements" ADD CONSTRAINT "helmet_replacements_original_helmet_id_fkey" FOREIGN KEY ("original_helmet_id") REFERENCES "helmets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_replacements" ADD CONSTRAINT "helmet_replacements_replacement_helmet_id_fkey" FOREIGN KEY ("replacement_helmet_id") REFERENCES "helmets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_replacements" ADD CONSTRAINT "helmet_replacements_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ───────────── Hand-written (Phase 3) ─────────────

-- At most one open transfer offer per helmet.
CREATE UNIQUE INDEX "helmet_transfers_one_pending_per_helmet"
  ON "helmet_transfers"("helmet_id") WHERE "status" = 'PENDING';

ALTER TABLE "helmet_transfers"
  ADD CONSTRAINT "helmet_transfers_claim_consistent"
  CHECK (("status" = 'CLAIMED') = ("to_user_id" IS NOT NULL AND "claimed_at" IS NOT NULL));

ALTER TABLE "helmet_transfers"
  ADD CONSTRAINT "helmet_transfers_not_to_self"
  CHECK ("to_user_id" IS NULL OR "to_user_id" <> "from_user_id");

-- A helmet can never replace itself.
ALTER TABLE "helmet_replacements"
  ADD CONSTRAINT "helmet_replacements_distinct"
  CHECK ("original_helmet_id" <> "replacement_helmet_id");

-- Ownership periods: ACTIVE ⇔ not ended. Backfill closed periods first.
UPDATE "helmet_ownerships"
  SET "ended_at" = COALESCE("transferred_at", "updated_at")
  WHERE "status" <> 'ACTIVE' AND "ended_at" IS NULL;

ALTER TABLE "helmet_ownerships"
  ADD CONSTRAINT "helmet_ownerships_period_consistent"
  CHECK (("status" = 'ACTIVE') = ("ended_at" IS NULL));

-- Phase 2 enabled the profile account-wide; helmets that are ACTIVE today keep exposing it,
-- now through an explicit per-helmet setting.
INSERT INTO "helmet_emergency_settings" ("id", "helmet_id", "user_id", "enabled", "confirmed_at", "created_at", "updated_at")
SELECT gen_random_uuid(), h."id", o."user_id", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "helmets" h
JOIN "helmet_ownerships" o ON o."helmet_id" = h."id" AND o."status" = 'ACTIVE'
WHERE h."status" = 'ACTIVE';
