-- Phase 6: analytics aggregates, explainable risk signals/assessments, deduplicated risk
-- alerts, QR integrity status (separate from lifecycle), worker job history, scan metadata.
-- Hand-written partial unique indexes at the end are not representable in schema.prisma.

-- CreateEnum
CREATE TYPE "DeviceCategory" AS ENUM ('MOBILE', 'TABLET', 'DESKTOP', 'BOT', 'OTHER');

-- CreateEnum
CREATE TYPE "QrIntegrityStatus" AS ENUM ('NORMAL', 'UNDER_REVIEW', 'COMPROMISED');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskSignalType" AS ENUM ('HIGH_SCAN_VOLUME', 'HIGH_UNIQUE_VISITOR_COUNT', 'RAPID_IP_CHURN', 'ABNORMAL_VERIFY_ACTIVITY', 'PRODUCT_REPORT_CORRELATION', 'QR_SHARED_OR_COPIED_POSSIBLE');

-- CreateEnum
CREATE TYPE "RiskSignalStatus" AS ENUM ('ACTIVE', 'CLEARED');

-- CreateEnum
CREATE TYPE "RiskAlertType" AS ENUM ('HELMET_SCAN_ANOMALY', 'HIGH_PUBLIC_SCAN_VOLUME', 'TOKEN_ENUMERATION', 'VALID_TOKEN_SCRAPING', 'SYSTEM_RATE_LIMIT_SPIKE');

-- CreateEnum
CREATE TYPE "RiskAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED', 'DISMISSED');

-- AlterTable
ALTER TABLE "helmet_scans" ADD COLUMN     "cache_hit" BOOLEAN,
ADD COLUMN     "device_category" "DeviceCategory",
ADD COLUMN     "synthetic" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "helmets" ADD COLUMN     "qr_integrity_changed_at" TIMESTAMPTZ(3),
ADD COLUMN     "qr_integrity_note" VARCHAR(500),
ADD COLUMN     "qr_integrity_status" "QrIntegrityStatus" NOT NULL DEFAULT 'NORMAL';

-- CreateTable
CREATE TABLE "helmet_scan_daily" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "helmet_id" UUID NOT NULL,
    "total_scans" INTEGER NOT NULL DEFAULT 0,
    "emergency_scans" INTEGER NOT NULL DEFAULT 0,
    "verification_scans" INTEGER NOT NULL DEFAULT 0,
    "activation_scans" INTEGER NOT NULL DEFAULT 0,
    "bot_scans" INTEGER NOT NULL DEFAULT 0,
    "unique_ip_hashes" INTEGER NOT NULL DEFAULT 0,
    "distinct_device_categories" INTEGER NOT NULL DEFAULT 0,
    "last_scan_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helmet_scan_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_daily_stats" (
    "date" DATE NOT NULL,
    "helmets_generated" INTEGER NOT NULL DEFAULT 0,
    "helmets_activated" INTEGER NOT NULL DEFAULT 0,
    "new_customers" INTEGER NOT NULL DEFAULT 0,
    "active_emergency_profiles" INTEGER NOT NULL DEFAULT 0,
    "emergency_scans" INTEGER NOT NULL DEFAULT 0,
    "verification_scans" INTEGER NOT NULL DEFAULT 0,
    "unique_helmets_scanned" INTEGER NOT NULL DEFAULT 0,
    "warranties_registered" INTEGER NOT NULL DEFAULT 0,
    "lost_helmets" INTEGER NOT NULL DEFAULT 0,
    "stolen_helmets" INTEGER NOT NULL DEFAULT 0,
    "damaged_helmets" INTEGER NOT NULL DEFAULT 0,
    "product_reports_created" INTEGER NOT NULL DEFAULT 0,
    "recovery_grants_issued" INTEGER NOT NULL DEFAULT 0,
    "invalid_token_requests" INTEGER NOT NULL DEFAULT 0,
    "risk_alerts_opened" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_daily_stats_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "helmet_risk_assessments" (
    "helmet_id" UUID NOT NULL,
    "risk_level" "RiskLevel" NOT NULL DEFAULT 'NONE',
    "risk_score" INTEGER NOT NULL DEFAULT 0,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "evaluated_at" TIMESTAMPTZ(3) NOT NULL,
    "first_detected_at" TIMESTAMPTZ(3),
    "last_detected_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_reason" VARCHAR(500),

    CONSTRAINT "helmet_risk_assessments_pkey" PRIMARY KEY ("helmet_id")
);

-- CreateTable
CREATE TABLE "helmet_risk_signals" (
    "id" UUID NOT NULL,
    "helmet_id" UUID NOT NULL,
    "type" "RiskSignalType" NOT NULL,
    "severity" "RiskLevel" NOT NULL,
    "status" "RiskSignalStatus" NOT NULL DEFAULT 'ACTIVE',
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,
    "observed_value" DOUBLE PRECISION NOT NULL,
    "threshold_value" DOUBLE PRECISION NOT NULL,
    "first_detected_at" TIMESTAMPTZ(3) NOT NULL,
    "last_detected_at" TIMESTAMPTZ(3) NOT NULL,
    "cleared_at" TIMESTAMPTZ(3),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "helmet_risk_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_alerts" (
    "id" UUID NOT NULL,
    "type" "RiskAlertType" NOT NULL,
    "status" "RiskAlertStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "RiskLevel" NOT NULL,
    "helmet_id" UUID,
    "source_ref" VARCHAR(16),
    "dedup_key" VARCHAR(120) NOT NULL,
    "summary" VARCHAR(300) NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "observed_value" DOUBLE PRECISION,
    "threshold_value" DOUBLE PRECISION,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "assigned_admin_id" UUID,
    "resolution_reason" VARCHAR(500),
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "risk_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_job_runs" (
    "id" UUID NOT NULL,
    "job" VARCHAR(60) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "detail" JSONB,
    "worker" VARCHAR(80),

    CONSTRAINT "worker_job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "helmet_scan_daily_date_total_scans_idx" ON "helmet_scan_daily"("date", "total_scans");

-- CreateIndex
CREATE UNIQUE INDEX "helmet_scan_daily_helmet_id_date_key" ON "helmet_scan_daily"("helmet_id", "date");

-- CreateIndex
CREATE INDEX "helmet_risk_assessments_risk_level_risk_score_idx" ON "helmet_risk_assessments"("risk_level", "risk_score");

-- CreateIndex
CREATE INDEX "helmet_risk_signals_helmet_id_status_idx" ON "helmet_risk_signals"("helmet_id", "status");

-- CreateIndex
CREATE INDEX "helmet_risk_signals_status_last_detected_at_idx" ON "helmet_risk_signals"("status", "last_detected_at");

-- CreateIndex
CREATE INDEX "risk_alerts_status_created_at_idx" ON "risk_alerts"("status", "created_at");

-- CreateIndex
CREATE INDEX "risk_alerts_helmet_id_created_at_idx" ON "risk_alerts"("helmet_id", "created_at");

-- CreateIndex
CREATE INDEX "risk_alerts_dedup_key_resolved_at_idx" ON "risk_alerts"("dedup_key", "resolved_at");

-- CreateIndex
CREATE INDEX "worker_job_runs_job_started_at_idx" ON "worker_job_runs"("job", "started_at");

-- AddForeignKey
ALTER TABLE "helmet_scan_daily" ADD CONSTRAINT "helmet_scan_daily_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_risk_assessments" ADD CONSTRAINT "helmet_risk_assessments_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "helmet_risk_signals" ADD CONSTRAINT "helmet_risk_signals_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_alerts" ADD CONSTRAINT "risk_alerts_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_alerts" ADD CONSTRAINT "risk_alerts_assigned_admin_id_fkey" FOREIGN KEY ("assigned_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_alerts" ADD CONSTRAINT "risk_alerts_resolved_by_admin_id_fkey" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Hand-written ──────────────────────────────────────────────────────────────────────────

-- One active signal per helmet and type; observations update it in place.
CREATE UNIQUE INDEX "helmet_risk_signals_one_active"
  ON "helmet_risk_signals" ("helmet_id", "type") WHERE "status" = 'ACTIVE';

-- One open (not resolved/dismissed) alert per dedup key: no alert spam.
CREATE UNIQUE INDEX "risk_alerts_one_open_per_key"
  ON "risk_alerts" ("dedup_key") WHERE "status" IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING');

ALTER TABLE "risk_alerts"
  ADD CONSTRAINT "risk_alerts_subject" CHECK ("helmet_id" IS NOT NULL OR "source_ref" IS NOT NULL OR "type" = 'SYSTEM_RATE_LIMIT_SPIKE');
ALTER TABLE "helmet_risk_assessments"
  ADD CONSTRAINT "helmet_risk_assessments_score_range" CHECK ("risk_score" BETWEEN 0 AND 100);
