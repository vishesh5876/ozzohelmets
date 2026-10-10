-- Pilot metrics (Phase 8). READ-ONLY: counts and durations only, never medical content,
-- never names, emails or phone numbers. Internal test helmets (model SKU OZZO-INTERNAL-TEST,
-- see ANALYTICS_EXCLUDED_MODEL_SKUS) are excluded.
--
--   sudo -u ozzo bash -c 'psql "$(sed -n "s/^DATABASE_URL=//p" /etc/helmet-platform/app.env | sed "s/?.*//")" \
--     -X -v since="2026-10-01" -f /opt/ozzohelmets/scripts/pilot-metrics.sql'
--
-- :since is the pilot start date (YYYY-MM-DD).
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

-- Helmets that count (everything except the internal test model), used as :pilot_helmets.
\set pilot_helmets '(SELECT h.* FROM helmets h JOIN helmet_models m ON m.id = h.helmet_model_id WHERE upper(m.sku) <> ''OZZO-INTERNAL-TEST'')'

\echo '== Activation'
SELECT
  count(*) FILTER (WHERE status <> 'GENERATED')                         AS printed_or_later,
  count(*) FILTER (WHERE activated_at IS NOT NULL)                      AS activated,
  count(*) FILTER (WHERE activated_at >= :'since'::date)                AS activated_in_pilot,
  round(100.0 * count(*) FILTER (WHERE activated_at IS NOT NULL)
        / nullif(count(*) FILTER (WHERE status <> 'GENERATED'), 0), 1) AS activation_rate_pct
FROM :pilot_helmets ph;

\echo '== Emergency profile completion and sharing (per activating customer)'
WITH owners AS (
  SELECT DISTINCT o.user_id FROM helmet_ownerships o
  JOIN :pilot_helmets h ON h.id = o.helmet_id
  WHERE o.status = 'ACTIVE' AND o.activated_at >= :'since'::date
)
SELECT
  count(*)                                                              AS new_owners,
  count(*) FILTER (WHERE p.emergency_profile_enabled)                   AS profile_enabled,
  round(100.0 * count(*) FILTER (WHERE p.emergency_profile_enabled) / nullif(count(*), 0), 1)
                                                                        AS profile_enabled_pct,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM emergency_contacts c
                                 WHERE c.user_id = owners.user_id AND c.is_active)) AS with_contact
FROM owners LEFT JOIN emergency_profiles p ON p.user_id = owners.user_id AND p.helmet_id IS NULL;

SELECT
  count(*) FILTER (WHERE status = 'ACTIVE')                             AS helmets_sharing,
  round(100.0 * count(*) FILTER (WHERE status = 'ACTIVE')
        / nullif(count(*) FILTER (WHERE activated_at IS NOT NULL), 0), 1) AS sharing_pct_of_activated
FROM :pilot_helmets ph;

\echo '== Time from activation to emergency sharing (minutes, helmets activated in the pilot)'
SELECT
  count(*)                                                              AS helmets,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY mins)::numeric, 1)  AS median_min,
  round(percentile_cont(0.9) WITHIN GROUP (ORDER BY mins)::numeric, 1)  AS p90_min
FROM (
  SELECT extract(epoch FROM (min(sh.created_at) - h.activated_at)) / 60 AS mins
  FROM :pilot_helmets h
  JOIN helmet_status_history sh ON sh.helmet_id = h.id AND sh.to_status = 'ACTIVE'
  WHERE h.activated_at >= :'since'::date
  GROUP BY h.id, h.activated_at
) t;

\echo '== Warranty'
SELECT
  count(w.id)                                                           AS registered,
  round(100.0 * count(w.id) / nullif(count(h.id) FILTER (WHERE h.activated_at IS NOT NULL), 0), 1)
                                                                        AS registration_pct_of_activated
FROM :pilot_helmets h LEFT JOIN helmet_warranties w ON w.helmet_id = h.id;

\echo '== Friction signals since the pilot start'
SELECT action, count(*) FROM audit_logs
WHERE created_at >= :'since'::date AND action IN (
  'helmet.activation.failed', 'helmet.activation.locked',
  'customer.login.failed', 'customer.recovery.verified', 'customer.recovery.failed',
  'customer.recovery_grant.issued', 'customer.recovery_grant.used')
GROUP BY action ORDER BY action;

\echo '== QR activity and review signals since the pilot start'
SELECT
  coalesce(sum(d.emergency_scans), 0)                                   AS emergency_scans,
  coalesce(sum(d.verification_scans), 0)                                AS verification_scans
FROM helmet_scan_daily d JOIN :pilot_helmets h ON h.id = d.helmet_id
WHERE d.date >= :'since'::date;
SELECT type, status, count(*) FROM risk_alerts
WHERE created_at >= :'since'::date GROUP BY type, status ORDER BY type, status;
SELECT reason, status, count(*) FROM product_reports
WHERE created_at >= :'since'::date GROUP BY reason, status ORDER BY reason, status;

ROLLBACK;
