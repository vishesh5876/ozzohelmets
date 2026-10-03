-- CreateEnum
CREATE TYPE "HelmetStatus" AS ENUM ('GENERATED', 'PRINTED', 'IN_INVENTORY', 'SOLD', 'ACTIVATED', 'ACTIVE', 'LOST', 'STOLEN', 'DAMAGED', 'REPLACED', 'DEACTIVATED', 'RECALLED');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'MANUFACTURING', 'SUPPORT', 'ANALYTICS_VIEWER');

-- CreateEnum
CREATE TYPE "AdminUserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "HelmetModelStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BatchGenerationStatus" AS ENUM ('PENDING', 'GENERATING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BatchPrintStatus" AS ENUM ('NOT_PRINTED', 'PRINTED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "OwnershipStatus" AS ENUM ('ACTIVE', 'TRANSFERRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "ScanType" AS ENUM ('EMERGENCY_PAGE', 'VERIFY', 'ACTIVATION');

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL,
    "status" "AdminUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_refresh_tokens" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "replaced_by" UUID,
    "user_agent" VARCHAR(255),
    "ip_hash" CHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120),
    "email" VARCHAR(254),
    "mobile" VARCHAR(20),
    "password_hash" TEXT,
    "mobile_verified" BOOLEAN NOT NULL DEFAULT false,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helmet_models" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "brand" VARCHAR(80) NOT NULL,
    "description" TEXT,
    "status" "HelmetModelStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helmet_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helmet_batches" (
    "id" UUID NOT NULL,
    "batch_code" VARCHAR(32) NOT NULL,
    "helmet_model_id" UUID NOT NULL,
    "manufacturing_date" DATE NOT NULL,
    "quantity" INTEGER NOT NULL,
    "generated_count" INTEGER NOT NULL DEFAULT 0,
    "generation_status" "BatchGenerationStatus" NOT NULL DEFAULT 'PENDING',
    "generation_error" VARCHAR(500),
    "generation_started_at" TIMESTAMPTZ(3),
    "generation_completed_at" TIMESTAMPTZ(3),
    "print_status" "BatchPrintStatus" NOT NULL DEFAULT 'NOT_PRINTED',
    "printed_at" TIMESTAMPTZ(3),
    "notes" VARCHAR(1000),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helmet_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helmets" (
    "id" UUID NOT NULL,
    "helmet_code" VARCHAR(16) NOT NULL,
    "public_token" VARCHAR(32) NOT NULL,
    "activation_pin_hash" TEXT NOT NULL,
    "activation_pin_used" BOOLEAN NOT NULL DEFAULT false,
    "activation_attempts" INTEGER NOT NULL DEFAULT 0,
    "serial_number" VARCHAR(40) NOT NULL,
    "helmet_model_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "status" "HelmetStatus" NOT NULL DEFAULT 'GENERATED',
    "activated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helmets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helmet_activation_secrets" (
    "helmet_id" UUID NOT NULL,
    "pin_ciphertext" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helmet_activation_secrets_pkey" PRIMARY KEY ("helmet_id")
);

-- CreateTable
CREATE TABLE "helmet_status_history" (
    "id" UUID NOT NULL,
    "helmet_id" UUID NOT NULL,
    "from_status" "HelmetStatus",
    "to_status" "HelmetStatus" NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helmet_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helmet_ownerships" (
    "id" UUID NOT NULL,
    "helmet_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "OwnershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "activated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "transferred_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helmet_ownerships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "helmet_scans" (
    "id" UUID NOT NULL,
    "helmet_id" UUID NOT NULL,
    "scanned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash" CHAR(64),
    "user_agent" VARCHAR(255),
    "country_code" CHAR(2),
    "scan_type" "ScanType" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "helmet_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "admin_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "entity_type" VARCHAR(60) NOT NULL,
    "entity_id" VARCHAR(64),
    "metadata" JSONB,
    "ip_hash" CHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_refresh_tokens_token_hash_key" ON "admin_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "admin_refresh_tokens_admin_id_idx" ON "admin_refresh_tokens"("admin_id");

-- CreateIndex
CREATE INDEX "admin_refresh_tokens_family_id_idx" ON "admin_refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_mobile_key" ON "users"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "helmet_models_sku_key" ON "helmet_models"("sku");

-- CreateIndex
CREATE INDEX "helmet_models_status_idx" ON "helmet_models"("status");

-- CreateIndex
CREATE UNIQUE INDEX "helmet_batches_batch_code_key" ON "helmet_batches"("batch_code");

-- CreateIndex
CREATE INDEX "helmet_batches_helmet_model_id_idx" ON "helmet_batches"("helmet_model_id");

-- CreateIndex
CREATE INDEX "helmet_batches_generation_status_idx" ON "helmet_batches"("generation_status");

-- CreateIndex
CREATE INDEX "helmet_batches_created_at_idx" ON "helmet_batches"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "helmets_helmet_code_key" ON "helmets"("helmet_code");

-- CreateIndex
CREATE UNIQUE INDEX "helmets_public_token_key" ON "helmets"("public_token");

-- CreateIndex
CREATE UNIQUE INDEX "helmets_serial_number_key" ON "helmets"("serial_number");

-- CreateIndex
CREATE INDEX "helmets_status_idx" ON "helmets"("status");

-- CreateIndex
CREATE INDEX "helmets_batch_id_idx" ON "helmets"("batch_id");

-- CreateIndex
CREATE INDEX "helmets_helmet_model_id_idx" ON "helmets"("helmet_model_id");

-- CreateIndex
CREATE INDEX "helmets_created_at_idx" ON "helmets"("created_at");

-- CreateIndex
CREATE INDEX "helmet_status_history_helmet_id_created_at_idx" ON "helmet_status_history"("helmet_id", "created_at");

-- CreateIndex
CREATE INDEX "helmet_ownerships_helmet_id_idx" ON "helmet_ownerships"("helmet_id");

-- CreateIndex
CREATE INDEX "helmet_ownerships_user_id_idx" ON "helmet_ownerships"("user_id");

-- CreateIndex
CREATE INDEX "helmet_scans_helmet_id_scanned_at_idx" ON "helmet_scans"("helmet_id", "scanned_at");

-- CreateIndex
CREATE INDEX "helmet_scans_scanned_at_idx" ON "helmet_scans"("scanned_at");

-- CreateIndex
CREATE INDEX "audit_logs_admin_id_created_at_idx" ON "audit_logs"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "admin_refresh_tokens" ADD CONSTRAINT "admin_refresh_tokens_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_batches" ADD CONSTRAINT "helmet_batches_helmet_model_id_fkey" FOREIGN KEY ("helmet_model_id") REFERENCES "helmet_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_batches" ADD CONSTRAINT "helmet_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmets" ADD CONSTRAINT "helmets_helmet_model_id_fkey" FOREIGN KEY ("helmet_model_id") REFERENCES "helmet_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmets" ADD CONSTRAINT "helmets_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "helmet_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_activation_secrets" ADD CONSTRAINT "helmet_activation_secrets_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_status_history" ADD CONSTRAINT "helmet_status_history_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_ownerships" ADD CONSTRAINT "helmet_ownerships_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_ownerships" ADD CONSTRAINT "helmet_ownerships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_scans" ADD CONSTRAINT "helmet_scans_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Hand-written additions (not expressible in Prisma schema) ───

-- Batch code counter: BAT-<year>-<nextval padded to 5>. Gaps are acceptable; uniqueness is not negotiable.
CREATE SEQUENCE "helmet_batch_code_seq" START WITH 1 INCREMENT BY 1 NO CYCLE;

-- At most one ACTIVE ownership per helmet (ownership history is preserved in other rows).
CREATE UNIQUE INDEX "helmet_ownerships_one_active_per_helmet"
  ON "helmet_ownerships" ("helmet_id") WHERE "status" = 'ACTIVE';

ALTER TABLE "helmet_batches"
  ADD CONSTRAINT "helmet_batches_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "helmet_batches_generated_within_quantity" CHECK ("generated_count" >= 0 AND "generated_count" <= "quantity");

ALTER TABLE "helmets"
  ADD CONSTRAINT "helmets_activated_at_when_pin_used" CHECK (NOT "activation_pin_used" OR "activated_at" IS NOT NULL);
