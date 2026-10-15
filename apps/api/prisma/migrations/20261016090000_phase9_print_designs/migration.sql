-- Phase 9 Print Designs: admin-controlled Safety ID artwork (additive; existing batches keep
-- print_design_id NULL = the built-in legacy layout).
-- CreateEnum
CREATE TYPE "PrintDesignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PrintArtworkFormat" AS ENUM ('SVG', 'PNG');

-- AlterTable
ALTER TABLE "safety_id_batches" ADD COLUMN     "print_design_id" UUID,
ADD COLUMN     "print_design_version" INTEGER;

-- CreateTable
CREATE TABLE "print_artwork_files" (
    "id" UUID NOT NULL,
    "storage_key" VARCHAR(120) NOT NULL,
    "format" "PrintArtworkFormat" NOT NULL,
    "original_filename" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(40) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width_px" INTEGER,
    "height_px" INTEGER,
    "svg_view_box" VARCHAR(120),
    "effective_dpi" INTEGER,
    "test_only" BOOLEAN NOT NULL DEFAULT false,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "print_artwork_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_designs" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PrintDesignStatus" NOT NULL DEFAULT 'DRAFT',
    "artwork_type" "PrintArtworkFormat" NOT NULL,
    "base_artwork_file_id" UUID NOT NULL,
    "cover_artwork_file_id" UUID,
    "scale_percent" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "offset_x_mm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "offset_y_mm" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "validation_errors" JSONB NOT NULL DEFAULT '[]',
    "validation_warnings" JSONB NOT NULL DEFAULT '[]',
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "activated_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "print_designs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "print_artwork_files_storage_key_key" ON "print_artwork_files"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "print_artwork_files_sha256_key" ON "print_artwork_files"("sha256");

-- CreateIndex
CREATE INDEX "print_designs_status_idx" ON "print_designs"("status");

-- CreateIndex
CREATE INDEX "print_designs_created_at_idx" ON "print_designs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "print_designs_family_id_version_key" ON "print_designs"("family_id", "version");

-- AddForeignKey
ALTER TABLE "safety_id_batches" ADD CONSTRAINT "safety_id_batches_print_design_id_fkey" FOREIGN KEY ("print_design_id") REFERENCES "print_designs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_artwork_files" ADD CONSTRAINT "print_artwork_files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_designs" ADD CONSTRAINT "print_designs_base_artwork_file_id_fkey" FOREIGN KEY ("base_artwork_file_id") REFERENCES "print_artwork_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_designs" ADD CONSTRAINT "print_designs_cover_artwork_file_id_fkey" FOREIGN KEY ("cover_artwork_file_id") REFERENCES "print_artwork_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_designs" ADD CONSTRAINT "print_designs_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Phase 9 Print Designs: at most one default (ACTIVE) design, and a batch's design version is
-- the referenced design's version (traceability; both are written once at batch creation).
CREATE UNIQUE INDEX "print_designs_single_active" ON "print_designs"("status") WHERE "status" = 'ACTIVE';
CREATE INDEX "safety_id_batches_print_design_id_idx" ON "safety_id_batches"("print_design_id");
ALTER TABLE "safety_id_batches" ADD CONSTRAINT "safety_id_batches_print_design_pair"
  CHECK (("print_design_id" IS NULL) = ("print_design_version" IS NULL));
