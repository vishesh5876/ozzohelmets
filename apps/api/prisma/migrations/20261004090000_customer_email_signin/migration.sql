-- Customer email sign-in: email becomes the normal login identifier, bound at first activation.
-- Uniqueness is restored on a canonical key via a NEW partial unique index (the Phase 2 migration
-- that dropped "users_email_key" is left untouched).

ALTER TABLE "users" ADD COLUMN "email_normalized" VARCHAR(254);

-- 1. Canonicalise stored emails the same way the application does: trim, lowercase the domain.
UPDATE "users"
SET "email" = NULLIF(btrim("email"), '')
WHERE "email" IS NOT NULL;

UPDATE "users"
SET "email" = split_part("email", '@', 1) || '@' || lower(split_part("email", '@', 2))
WHERE "email" LIKE '%_@_%' AND "email" NOT LIKE '%@%@%';

-- 2. Backfill the lookup key only for well-formed addresses.
UPDATE "users"
SET "email_normalized" = lower("email")
WHERE "email" LIKE '%_@_%.__%' AND "email" NOT LIKE '%@%@%' AND "email" !~ '\s';

-- 3. Duplicates among non-deleted accounts: accounts are NEVER merged. The oldest account keeps
--    email sign-in; every other account keeps its raw "email" but gets a NULL lookup key, so it
--    can still sign in with its Customer ID / Helmet ID and set a new email itself. Each conflict
--    is reported here and is queryable afterwards (email IS NOT NULL AND email_normalized IS NULL).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, customer_code, email_normalized
    FROM (
      SELECT id, customer_code, email_normalized,
             row_number() OVER (PARTITION BY email_normalized ORDER BY created_at, id) AS rn
      FROM "users"
      WHERE email_normalized IS NOT NULL AND status <> 'DELETED'
    ) d
    WHERE d.rn > 1
  LOOP
    RAISE NOTICE 'Duplicate account email: % lost email sign-in (kept on the oldest account)', r.customer_code;
    UPDATE "users" SET "email_normalized" = NULL WHERE id = r.id;
  END LOOP;
END $$;

-- 4. Uniqueness among live accounts (DELETED accounts release their address).
CREATE UNIQUE INDEX "users_email_normalized_live_key"
  ON "users" ("email_normalized")
  WHERE "email_normalized" IS NOT NULL AND "status" <> 'DELETED';
