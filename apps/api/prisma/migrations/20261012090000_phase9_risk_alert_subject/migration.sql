-- Phase 9: a risk alert may be about a standalone Safety ID (no helmet). Widen the Phase 6 subject
-- check so safety_id counts as a subject. Forward-only and purely relaxing: every existing row
-- already satisfies the new condition, so validation cannot fail.
ALTER TABLE "risk_alerts" DROP CONSTRAINT "risk_alerts_subject";
ALTER TABLE "risk_alerts"
  ADD CONSTRAINT "risk_alerts_subject" CHECK (
    "helmet_id" IS NOT NULL OR "safety_id" IS NOT NULL OR "source_ref" IS NOT NULL
    OR "type" = 'SYSTEM_RATE_LIMIT_SPIKE'
  );
