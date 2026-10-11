-- Phase 8 → Phase 9 migration verification (read-only). Run AFTER `prisma migrate deploy`
-- on a copy of production (or production itself, after the backup). Every row must say OK.
--   psql "$DATABASE_URL" -X -f apps/api/scripts/verify-phase9-migration.sql
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
WITH checks(check_name, ok, detail) AS (
  SELECT 'every QR-bearing helmet has exactly one Safety ID with the SAME id',
         count(*) = 0, count(*) || ' helmets without a Safety ID'
  FROM helmets h WHERE h.public_token IS NOT NULL AND h.activation_pin_hash IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM safety_ids s WHERE s.id = h.id)
UNION ALL
  SELECT 'public token identical for every migrated QR (printed labels keep working)',
         count(*) = 0, count(*) || ' token mismatches'
  FROM helmets h JOIN safety_ids s ON s.id = h.id WHERE s.public_token IS DISTINCT FROM h.public_token
UNION ALL
  SELECT 'PIN hash and used flag identical (unused printed PINs keep working)',
         count(*) = 0, count(*) || ' PIN mismatches'
  FROM helmets h JOIN safety_ids s ON s.id = h.id
  WHERE s.activation_pin_hash IS DISTINCT FROM h.activation_pin_hash
     OR s.activation_pin_used IS DISTINCT FROM h.activation_pin_used
UNION ALL
  SELECT 'Safety ID code = SI + Helmet ID body', count(*) = 0, count(*) || ' code mismatches'
  FROM helmets h JOIN safety_ids s ON s.id = h.id WHERE s.safety_code <> 'SI-' || substr(h.helmet_code, 4)
UNION ALL
  SELECT 'PIN escrow rows copied', count(*) = 0, count(*) || ' escrow rows missing'
  FROM helmet_activation_secrets a
  WHERE NOT EXISTS (SELECT 1 FROM safety_id_activation_secrets b WHERE b.safety_id = a.helmet_id AND b.pin_ciphertext = a.pin_ciphertext)
UNION ALL
  SELECT 'every migrated Safety ID linked to its helmet', count(*) = 0, count(*) || ' links missing'
  FROM safety_ids s JOIN helmets h ON h.id = s.id
  WHERE NOT EXISTS (SELECT 1 FROM safety_id_helmet_links l WHERE l.safety_id = s.id AND l.helmet_id = h.id AND l.ended_at IS NULL)
UNION ALL
  SELECT 'current owner identical (helmet owner = Safety ID owner)', count(*) = 0, count(*) || ' owner mismatches'
  FROM helmet_ownerships o
  WHERE o.status = 'ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM safety_id_ownerships so WHERE so.safety_id = o.helmet_id AND so.user_id = o.user_id AND so.status = 'ACTIVE')
UNION ALL
  SELECT 'ownership history row counts equal',
         (SELECT count(*) FROM helmet_ownerships o JOIN safety_ids s ON s.id = o.helmet_id) = (SELECT count(*) FROM safety_id_ownerships WHERE source = 'MIGRATION'),
         (SELECT count(*) FROM safety_id_ownerships WHERE source = 'MIGRATION') || ' Safety ID periods'
UNION ALL
  SELECT 'emergency sharing switches identical (none switched on or off)', count(*) = 0, count(*) || ' switch mismatches'
  FROM helmet_emergency_settings e
  LEFT JOIN safety_id_emergency_settings s ON s.safety_id = e.helmet_id AND s.user_id = e.user_id
  WHERE s.id IS NULL OR s.enabled <> e.enabled
UNION ALL
  SELECT 'Safety ID ACTIVE exactly when the current owner''s sharing switch is on (Phase 8 exposure rule)',
         count(*) = 0, count(*) || ' mismatches'
  FROM safety_ids s
  WHERE (s.status = 'ACTIVE') <> EXISTS (
    SELECT 1 FROM safety_id_ownerships o
    JOIN safety_id_emergency_settings e ON e.safety_id = o.safety_id AND e.user_id = o.user_id
    WHERE o.safety_id = s.id AND o.status = 'ACTIVE' AND e.enabled)
UNION ALL
  SELECT 'every scan attached to its Safety ID, none duplicated', count(*) = 0, count(*) || ' scans without safety_id'
  FROM helmet_scans WHERE safety_id IS NULL
UNION ALL
  SELECT 'daily aggregates copied', (SELECT count(*) FROM helmet_scan_daily) = (SELECT count(*) FROM safety_id_scan_daily),
         (SELECT count(*) FROM safety_id_scan_daily) || ' rows'
UNION ALL
  SELECT 'risk assessments copied', (SELECT count(*) FROM helmet_risk_assessments) = (SELECT count(*) FROM safety_id_risk_assessments),
         (SELECT count(*) FROM safety_id_risk_assessments) || ' rows'
UNION ALL
  SELECT 'risk signals copied', (SELECT count(*) FROM helmet_risk_signals) = (SELECT count(*) FROM safety_id_risk_signals),
         (SELECT count(*) FROM safety_id_risk_signals) || ' rows'
UNION ALL
  SELECT 'helmet risk alerts point at their Safety ID', count(*) = 0, count(*) || ' alerts missing safety_id'
  FROM risk_alerts WHERE helmet_id IS NOT NULL AND safety_id IS NULL
UNION ALL
  SELECT 'no helmet-scoped dedup keys left', count(*) = 0, count(*) || ' keys' FROM risk_alerts WHERE dedup_key LIKE 'helmet:%'
)
SELECT CASE WHEN ok THEN 'OK  ' ELSE 'FAIL' END AS result, check_name, detail FROM checks;

SELECT 'helmets' AS what, count(*) FROM helmets UNION ALL
SELECT 'safety_ids', count(*) FROM safety_ids UNION ALL
SELECT 'helmet owners (active)', count(*) FROM helmet_ownerships WHERE status = 'ACTIVE' UNION ALL
SELECT 'safety id owners (active)', count(*) FROM safety_id_ownerships WHERE status = 'ACTIVE' UNION ALL
SELECT 'sharing on (helmet switches)', count(*) FROM helmet_emergency_settings WHERE enabled UNION ALL
SELECT 'sharing on (safety id switches)', count(*) FROM safety_id_emergency_settings WHERE enabled UNION ALL
SELECT 'unused PINs (safety ids)', count(*) FROM safety_ids WHERE NOT activation_pin_used UNION ALL
SELECT 'escrow rows (safety ids)', count(*) FROM safety_id_activation_secrets UNION ALL
SELECT 'scans', count(*) FROM helmet_scans UNION ALL
SELECT 'warranties', count(*) FROM helmet_warranties UNION ALL
SELECT 'info: ACTIVE helmets without an enabled switch (not shared in Phase 8 either)', count(*)
  FROM helmets h WHERE h.status = 'ACTIVE' AND NOT EXISTS (
    SELECT 1 FROM helmet_ownerships o JOIN helmet_emergency_settings e ON e.helmet_id = o.helmet_id AND e.user_id = o.user_id
    WHERE o.helmet_id = h.id AND o.status = 'ACTIVE' AND e.enabled);
ROLLBACK;
