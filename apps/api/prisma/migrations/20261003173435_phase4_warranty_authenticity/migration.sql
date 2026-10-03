-- CreateEnum
CREATE TYPE "WarrantyStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'VOID', 'REPLACED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WarrantyRegistrationSource" AS ENUM ('CUSTOMER', 'ADMIN', 'REPLACEMENT');

-- CreateEnum
CREATE TYPE "PurchaseChannel" AS ENUM ('BRAND_WEBSITE', 'DEALER', 'MARKETPLACE', 'RETAIL_STORE', 'OTHER');

-- CreateEnum
CREATE TYPE "WarrantyVoidReason" AS ENUM ('INVALID_PURCHASE', 'TAMPERED_PRODUCT', 'DUPLICATE_REGISTRATION', 'ADMIN_CORRECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "WarrantyEvent" AS ENUM ('REGISTERED', 'DATE_CORRECTED', 'ADMIN_UPDATED', 'VOIDED', 'RESTORED', 'REPLACED', 'ISSUED_FOR_REPLACEMENT', 'PROOF_UPLOADED', 'PROOF_REMOVED');

-- CreateEnum
CREATE TYPE "ProductReportReason" AS ENUM ('QR_COPIED', 'DETAILS_MISMATCH', 'LOOKS_COUNTERFEIT', 'ID_DAMAGED', 'OTHER');

-- CreateEnum
CREATE TYPE "ProductReportStatus" AS ENUM ('OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED');

-- AlterTable
ALTER TABLE "helmet_models" ADD COLUMN     "warranty_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "warranty_months" INTEGER NOT NULL DEFAULT 24;

-- CreateTable
CREATE TABLE "helmet_warranties" (
    "id" UUID NOT NULL,
    "helmet_id" UUID NOT NULL,
    "registered_by_user_id" UUID,
    "status" "WarrantyStatus" NOT NULL DEFAULT 'ACTIVE',
    "registration_source" "WarrantyRegistrationSource" NOT NULL,
    "purchase_date" DATE NOT NULL,
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warranty_start_date" DATE NOT NULL,
    "warranty_end_date" DATE NOT NULL,
    "purchase_channel" "PurchaseChannel",
    "seller_name" VARCHAR(120),
    "seller_city" VARCHAR(80),
    "invoice_number" VARCHAR(64),
    "notes" VARCHAR(500),
    "proof_key" VARCHAR(255),
    "proof_content_type" VARCHAR(40),
    "proof_uploaded_at" TIMESTAMPTZ(3),
    "void_reason" "WarrantyVoidReason",
    "voided_at" TIMESTAMPTZ(3),
    "replacement_of_warranty_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helmet_warranties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warranty_history" (
    "id" UUID NOT NULL,
    "warranty_id" UUID NOT NULL,
    "event" "WarrantyEvent" NOT NULL,
    "from_status" "WarrantyStatus",
    "to_status" "WarrantyStatus" NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "reason_code" VARCHAR(60),
    "note" VARCHAR(300),
    "changes" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warranty_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_reports" (
    "id" UUID NOT NULL,
    "helmet_id" UUID,
    "public_token" VARCHAR(32),
    "reason" "ProductReportReason" NOT NULL,
    "description" VARCHAR(1000),
    "contact_email" VARCHAR(254),
    "status" "ProductReportStatus" NOT NULL DEFAULT 'OPEN',
    "ip_hash" CHAR(64),
    "reviewed_by_admin_id" UUID,
    "resolution_note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "helmet_warranties_helmet_id_key" ON "helmet_warranties"("helmet_id");

-- CreateIndex
CREATE UNIQUE INDEX "helmet_warranties_replacement_of_warranty_id_key" ON "helmet_warranties"("replacement_of_warranty_id");

-- CreateIndex
CREATE INDEX "helmet_warranties_status_warranty_end_date_idx" ON "helmet_warranties"("status", "warranty_end_date");

-- CreateIndex
CREATE INDEX "helmet_warranties_invoice_number_idx" ON "helmet_warranties"("invoice_number");

-- CreateIndex
CREATE INDEX "warranty_history_warranty_id_created_at_idx" ON "warranty_history"("warranty_id", "created_at");

-- CreateIndex
CREATE INDEX "product_reports_status_created_at_idx" ON "product_reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "product_reports_helmet_id_idx" ON "product_reports"("helmet_id");

-- AddForeignKey
ALTER TABLE "helmet_warranties" ADD CONSTRAINT "helmet_warranties_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_warranties" ADD CONSTRAINT "helmet_warranties_registered_by_user_id_fkey" FOREIGN KEY ("registered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_warranties" ADD CONSTRAINT "helmet_warranties_replacement_of_warranty_id_fkey" FOREIGN KEY ("replacement_of_warranty_id") REFERENCES "helmet_warranties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warranty_history" ADD CONSTRAINT "warranty_history_warranty_id_fkey" FOREIGN KEY ("warranty_id") REFERENCES "helmet_warranties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reports" ADD CONSTRAINT "product_reports_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_reports" ADD CONSTRAINT "product_reports_reviewed_by_admin_id_fkey" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────────── Hand-written (Phase 4) ─────────────

ALTER TABLE "helmet_models"
  ADD CONSTRAINT "helmet_models_warranty_months_range" CHECK ("warranty_months" BETWEEN 0 AND 240);

ALTER TABLE "helmet_warranties"
  ADD CONSTRAINT "helmet_warranties_dates_ordered"
  CHECK ("warranty_start_date" <= "warranty_end_date" AND "purchase_date" <= "warranty_start_date"),
  ADD CONSTRAINT "helmet_warranties_void_consistent"
  CHECK (("status" = 'VOID') = ("void_reason" IS NOT NULL)),
  ADD CONSTRAINT "helmet_warranties_proof_consistent"
  CHECK (("proof_key" IS NULL) = ("proof_content_type" IS NULL));
