-- Phase 5: customer support, account recovery grants, privacy requests, security events,
-- product report triage. Hand-written parts at the end (partial unique indexes, trigram search
-- indexes, backfill) are not representable in schema.prisma.

-- CreateEnum
CREATE TYPE "CustomerSecurityEventType" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILURE_THRESHOLD', 'PASSWORD_CHANGED', 'EMAIL_CHANGED', 'RECOVERY_CODE_ROTATED', 'RECOVERY_CODE_ACKNOWLEDGED', 'PASSWORD_RECOVERED', 'SESSION_REVOKED', 'ALL_SESSIONS_REVOKED', 'ACCOUNT_RECOVERY_GRANT_ISSUED', 'ACCOUNT_RECOVERY_GRANT_USED', 'HELMET_ACTIVATED', 'HELMET_TRANSFERRED_OUT', 'HELMET_RECEIVED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_LOCKED', 'ACCOUNT_RESTORED', 'ACCOUNT_DELETED', 'DATA_EXPORTED', 'DELETION_REQUESTED', 'DELETION_CANCELLED');

-- CreateEnum
CREATE TYPE "AccountDeletionStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductReportPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "ProductReportEventType" AS ENUM ('STATUS_CHANGED', 'PRIORITY_CHANGED', 'ASSIGNED', 'NOTE');

-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'LOCKED';

-- AlterTable
ALTER TABLE "product_reports" ADD COLUMN     "assigned_admin_id" UUID,
ADD COLUMN     "priority" "ProductReportPriority" NOT NULL DEFAULT 'NORMAL';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "recovery_code_acknowledged_at" TIMESTAMPTZ(3),
ADD COLUMN     "status_changed_at" TIMESTAMPTZ(3),
ADD COLUMN     "status_reason" VARCHAR(300);

-- CreateTable
CREATE TABLE "product_report_events" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "admin_id" UUID,
    "type" "ProductReportEventType" NOT NULL,
    "from_value" VARCHAR(40),
    "to_value" VARCHAR(40),
    "note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_report_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_security_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "CustomerSecurityEventType" NOT NULL,
    "session_id" UUID,
    "ip_hash" CHAR(64),
    "user_agent_summary" VARCHAR(60),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_recovery_grants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_hash" TEXT NOT NULL,
    "issued_by_admin_id" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_recovery_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_deletion_requests" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "AccountDeletionStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" VARCHAR(500),
    "review_note" VARCHAR(500),
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(3),
    "reviewed_by_admin_id" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_report_events_report_id_created_at_idx" ON "product_report_events"("report_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_security_events_user_id_created_at_idx" ON "customer_security_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "customer_security_events_type_created_at_idx" ON "customer_security_events"("type", "created_at");

-- CreateIndex
CREATE INDEX "customer_security_events_created_at_idx" ON "customer_security_events"("created_at");

-- CreateIndex
CREATE INDEX "account_recovery_grants_user_id_created_at_idx" ON "account_recovery_grants"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "account_deletion_requests_status_requested_at_idx" ON "account_deletion_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "account_deletion_requests_user_id_idx" ON "account_deletion_requests"("user_id");

-- CreateIndex
CREATE INDEX "product_reports_assigned_admin_id_status_idx" ON "product_reports"("assigned_admin_id", "status");

-- CreateIndex
CREATE INDEX "users_status_created_at_idx" ON "users"("status", "created_at");

-- AddForeignKey
ALTER TABLE "product_reports" ADD CONSTRAINT "product_reports_assigned_admin_id_fkey" FOREIGN KEY ("assigned_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_report_events" ADD CONSTRAINT "product_report_events_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "product_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_report_events" ADD CONSTRAINT "product_report_events_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_security_events" ADD CONSTRAINT "customer_security_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_recovery_grants" ADD CONSTRAINT "account_recovery_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_recovery_grants" ADD CONSTRAINT "account_recovery_grants_issued_by_admin_id_fkey" FOREIGN KEY ("issued_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_reviewed_by_admin_id_fkey" FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Hand-written ──────────────────────────────────────────────────────────────────────────

-- At most one open recovery grant and one open deletion request per customer.
CREATE UNIQUE INDEX "account_recovery_grants_one_open_per_user"
  ON "account_recovery_grants" ("user_id") WHERE "used_at" IS NULL AND "revoked_at" IS NULL;
CREATE UNIQUE INDEX "account_deletion_requests_one_open_per_user"
  ON "account_deletion_requests" ("user_id") WHERE "status" IN ('REQUESTED', 'APPROVED');

ALTER TABLE "account_recovery_grants"
  ADD CONSTRAINT "account_recovery_grants_expiry_after_creation" CHECK ("expires_at" > "created_at");

-- Admin customer search: partial (substring) match on email and name. pg_trgm ships with
-- PostgreSQL contrib and is available on managed PostgreSQL (RDS, Cloud SQL, Azure).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Expression indexes (lower() is a no-op on the already-lowercased key) keep Prisma's diff quiet.
CREATE INDEX "users_email_normalized_trgm_idx"
  ON "users" USING gin (lower("email_normalized") gin_trgm_ops);
CREATE INDEX "users_name_lower_trgm_idx"
  ON "users" USING gin (lower("name") gin_trgm_ops);

-- Accounts that already exist were required to tick "I've saved my recovery code" in the UI.
UPDATE "users" SET "recovery_code_acknowledged_at" = "recovery_code_created_at"
WHERE "recovery_code_hash" IS NOT NULL AND "recovery_code_acknowledged_at" IS NULL;
