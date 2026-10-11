-- Phase 9 reconcile: re-applies the Phase 8 → 9 backfill for anything the OLD (Phase 8) app wrote
-- after the migration ran but before the Phase 9 app took over (the deploy window), or after a
-- rollback to Phase 8 and a second roll-forward. Idempotent: running it on a consistent database
-- changes nothing. It only touches migrated pairs that are still linked (Safety ID id = helmet
-- id, current link between them), which are the only rows the Phase 8 app knows about; a Safety
-- ID that an admin unlinked or re-linked is never touched. Run as one transaction:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f apps/api/scripts/reconcile-phase9.sql
--
-- Then run verify-phase9-migration.sql; every check must read OK.

-- R1. Helmets created by the old app (e.g. a batch generated in the window) get their Safety ID,
-- escrow and link (same rules as migration steps 3.1 – 3.3).
INSERT INTO "safety_ids" (
  "id", "safety_code", "public_token", "status",
  "activation_pin_hash", "activation_pin_used", "activation_attempts", "activation_locked_until",
  "qr_integrity_status", "qr_integrity_note", "qr_integrity_changed_at",
  "activated_at", "created_at", "updated_at")
SELECT h."id", 'SI-' || substr(h."helmet_code", 4), h."public_token",
  (CASE WHEN h."activated_at" IS NULL AND NOT h."activation_pin_used" THEN
          CASE WHEN h."status" = 'GENERATED' THEN 'GENERATED' ELSE 'PRINTED' END
        ELSE 'ACTIVATED' END)::"SafetyIdStatus",
  h."activation_pin_hash", h."activation_pin_used", h."activation_attempts", h."activation_locked_until",
  h."qr_integrity_status", h."qr_integrity_note", h."qr_integrity_changed_at",
  h."activated_at", h."created_at", CURRENT_TIMESTAMP
FROM "helmets" h
WHERE h."public_token" IS NOT NULL AND h."activation_pin_hash" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "safety_ids" s WHERE s."id" = h."id")
  AND NOT EXISTS (SELECT 1 FROM "safety_ids" s WHERE s."public_token" = h."public_token")
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "safety_id_activation_secrets" ("safety_id", "pin_ciphertext", "created_at", "updated_at")
SELECT s."helmet_id", s."pin_ciphertext", s."created_at", s."updated_at"
FROM "helmet_activation_secrets" s
JOIN "safety_ids" si ON si."id" = s."helmet_id" AND NOT si."activation_pin_used"
ON CONFLICT ("safety_id") DO NOTHING;

INSERT INTO "safety_id_helmet_links" ("id", "safety_id", "helmet_id", "started_at", "reason", "created_at")
SELECT gen_random_uuid(), si."id", si."id", si."created_at", 'MIGRATION', CURRENT_TIMESTAMP
FROM "safety_ids" si JOIN "helmets" h ON h."id" = si."id"
WHERE NOT EXISTS (SELECT 1 FROM "safety_id_helmet_links" l WHERE l."safety_id" = si."id" AND l."ended_at" IS NULL)
  AND NOT EXISTS (SELECT 1 FROM "safety_id_helmet_links" l WHERE l."helmet_id" = h."id" AND l."ended_at" IS NULL)
  AND NOT EXISTS (SELECT 1 FROM "safety_id_helmet_links" l WHERE l."safety_id" = si."id");

-- R2. Activation done by the old app: PIN consumed on the helmet but not on its Safety ID.
UPDATE "safety_ids" si SET
  "activation_pin_used" = true,
  "activation_attempts" = 0,
  "activation_locked_until" = NULL,
  "activated_at" = COALESCE(si."activated_at", h."activated_at"),
  "status" = CASE WHEN si."status" IN ('GENERATED', 'PRINTED') THEN 'ACTIVATED'::"SafetyIdStatus" ELSE si."status" END,
  "updated_at" = CURRENT_TIMESTAMP
FROM "helmets" h
WHERE h."id" = si."id" AND h."activation_pin_used" AND NOT si."activation_pin_used"
  AND EXISTS (SELECT 1 FROM "safety_id_helmet_links" pl WHERE pl."safety_id" = si."id" AND pl."helmet_id" = si."id" AND pl."ended_at" IS NULL);
-- Escrow the old app purged on activation (helmet escrow gone, PIN consumed) goes here too.
DELETE FROM "safety_id_activation_secrets" e
USING "safety_ids" si
WHERE si."id" = e."safety_id" AND si."activation_pin_used"
  AND EXISTS (SELECT 1 FROM "helmets" h WHERE h."id" = si."id" AND h."activation_pin_used")
  AND NOT EXISTS (SELECT 1 FROM "helmet_activation_secrets" hs WHERE hs."helmet_id" = si."id");

-- Wrong-PIN counters written by the old app (only ever increase while the PIN is unused).
UPDATE "safety_ids" si SET
  "activation_attempts" = h."activation_attempts",
  "activation_locked_until" = h."activation_locked_until",
  "updated_at" = CURRENT_TIMESTAMP
FROM "helmets" h
WHERE h."id" = si."id" AND NOT si."activation_pin_used"
  AND h."activation_attempts" > si."activation_attempts"
  AND EXISTS (SELECT 1 FROM "safety_id_helmet_links" pl WHERE pl."safety_id" = si."id" AND pl."helmet_id" = si."id" AND pl."ended_at" IS NULL);

-- R3. Ownership changes made by the old app (activation, transfer claim, revoke). The helmet's
-- ownership is authoritative for migrated pairs: end Safety ID periods that no longer match and
-- open the missing current one.
UPDATE "safety_id_ownerships" so SET
  "status" = COALESCE(ho."status", 'REVOKED'::"OwnershipStatus"),
  "ended_at" = COALESCE(ho."ended_at", CURRENT_TIMESTAMP),
  "end_reason" = COALESCE(ho."end_reason", 'RECONCILED'),
  "updated_at" = CURRENT_TIMESTAMP
FROM "safety_ids" si
LEFT JOIN LATERAL (
  SELECT o."status", o."ended_at", o."end_reason" FROM "helmet_ownerships" o
  WHERE o."helmet_id" = si."id" AND o."status" <> 'ACTIVE'
  ORDER BY o."ended_at" DESC NULLS LAST LIMIT 1) ho ON true
WHERE so."safety_id" = si."id" AND so."status" = 'ACTIVE'
  AND EXISTS (SELECT 1 FROM "safety_id_helmet_links" pl WHERE pl."safety_id" = si."id" AND pl."helmet_id" = si."id" AND pl."ended_at" IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "helmet_ownerships" o
    WHERE o."helmet_id" = si."id" AND o."status" = 'ACTIVE' AND o."user_id" = so."user_id");

INSERT INTO "safety_id_ownerships" (
  "id", "safety_id", "user_id", "status", "source", "started_at", "created_at", "updated_at")
SELECT gen_random_uuid(), o."helmet_id", o."user_id", 'ACTIVE', 'MIGRATION', o."activated_at",
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "helmet_ownerships" o
JOIN "safety_ids" si ON si."id" = o."helmet_id"
WHERE o."status" = 'ACTIVE' AND EXISTS (SELECT 1 FROM "safety_id_helmet_links" pl WHERE pl."safety_id" = si."id" AND pl."helmet_id" = si."id" AND pl."ended_at" IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "safety_id_ownerships" so WHERE so."safety_id" = o."helmet_id" AND so."status" = 'ACTIVE');

-- R4. Sharing switches changed by the old app: the helmet switch is authoritative for migrated
-- pairs (the Phase 9 app dual-writes it, so this is a no-op once Phase 9 runs).
INSERT INTO "safety_id_emergency_settings" (
  "id", "safety_id", "user_id", "enabled", "confirmed_at", "created_at", "updated_at")
SELECT gen_random_uuid(), e."helmet_id", e."user_id", e."enabled", e."confirmed_at", e."created_at", CURRENT_TIMESTAMP
FROM "helmet_emergency_settings" e JOIN "safety_ids" si ON si."id" = e."helmet_id"
WHERE EXISTS (SELECT 1 FROM "safety_id_helmet_links" pl WHERE pl."safety_id" = si."id" AND pl."helmet_id" = si."id" AND pl."ended_at" IS NULL)
ON CONFLICT ("safety_id", "user_id") DO UPDATE SET
  "enabled" = EXCLUDED."enabled",
  "confirmed_at" = COALESCE(EXCLUDED."confirmed_at", "safety_id_emergency_settings"."confirmed_at"),
  "updated_at" = CURRENT_TIMESTAMP
WHERE "safety_id_emergency_settings"."enabled" IS DISTINCT FROM EXCLUDED."enabled";

-- Status follows the current owner's switch (ACTIVE ⇔ switch on), never touching
-- GENERATED / PRINTED / DEACTIVATED / REPLACED.
UPDATE "safety_ids" si SET "status" = 'ACTIVE', "updated_at" = CURRENT_TIMESTAMP
WHERE si."status" = 'ACTIVATED' AND EXISTS (
  SELECT 1 FROM "safety_id_ownerships" so
  JOIN "safety_id_emergency_settings" s ON s."safety_id" = so."safety_id" AND s."user_id" = so."user_id"
  WHERE so."safety_id" = si."id" AND so."status" = 'ACTIVE' AND s."enabled");
UPDATE "safety_ids" si SET "status" = 'ACTIVATED', "updated_at" = CURRENT_TIMESTAMP
WHERE si."status" = 'ACTIVE' AND NOT EXISTS (
  SELECT 1 FROM "safety_id_ownerships" so
  JOIN "safety_id_emergency_settings" s ON s."safety_id" = so."safety_id" AND s."user_id" = so."user_id"
  WHERE so."safety_id" = si."id" AND so."status" = 'ACTIVE' AND s."enabled");

-- R5. Scans the old app recorded without a Safety ID: attach to the helmet's current Safety ID.
UPDATE "helmet_scans" sc SET "safety_id" = l."safety_id"
FROM "safety_id_helmet_links" l
WHERE sc."safety_id" IS NULL AND sc."helmet_id" = l."helmet_id" AND l."ended_at" IS NULL;

-- R6. QR integrity decisions the old app stored on the helmet.
UPDATE "safety_ids" si SET
  "qr_integrity_status" = h."qr_integrity_status",
  "qr_integrity_note" = h."qr_integrity_note",
  "qr_integrity_changed_at" = h."qr_integrity_changed_at",
  "updated_at" = CURRENT_TIMESTAMP
FROM "helmets" h
WHERE h."id" = si."id" AND h."qr_integrity_changed_at" IS NOT NULL AND EXISTS (SELECT 1 FROM "safety_id_helmet_links" pl WHERE pl."safety_id" = si."id" AND pl."helmet_id" = si."id" AND pl."ended_at" IS NULL)
  AND (si."qr_integrity_changed_at" IS NULL OR h."qr_integrity_changed_at" > si."qr_integrity_changed_at");

-- R7. Alerts / reports the old app created for a helmet.
UPDATE "risk_alerts" a SET "safety_id" = l."safety_id"
FROM "safety_id_helmet_links" l
WHERE a."safety_id" IS NULL AND a."helmet_id" = l."helmet_id" AND l."ended_at" IS NULL;
UPDATE "risk_alerts" a SET "dedup_key" = 'safety:' || substr(a."dedup_key", 8)
WHERE a."dedup_key" LIKE 'helmet:%' AND NOT EXISTS (
  SELECT 1 FROM "risk_alerts" o WHERE o."dedup_key" = 'safety:' || substr(a."dedup_key", 8)
    AND o."status" IN ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING'));
UPDATE "product_reports" r SET "safety_id" = l."safety_id"
FROM "safety_id_helmet_links" l
WHERE r."safety_id" IS NULL AND r."helmet_id" = l."helmet_id" AND l."ended_at" IS NULL;
