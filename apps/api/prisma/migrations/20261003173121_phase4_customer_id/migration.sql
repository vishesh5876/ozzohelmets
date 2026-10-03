-- Phase 4: permanent public Customer ID (`CU-XXXX-XXXY`).
-- Same unambiguous 31-symbol alphabet and weighted mod-31 check symbol as Helmet IDs.

ALTER TABLE "users" ADD COLUMN "customer_code" VARCHAR(16);

-- Backfill helper (dropped at the end). Random symbols come from gen_random_uuid() (CSPRNG)
-- with rejection sampling so every symbol is uniform.
CREATE FUNCTION phase4_generate_customer_code() RETURNS text AS $$
DECLARE
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  payload  text := '';
  bytes    bytea;
  b        int;
  i        int := 0;
  s        int := 0;
  check_value int;
BEGIN
  WHILE length(payload) < 7 LOOP
    bytes := uuid_send(gen_random_uuid());
    FOR i IN 0..15 LOOP
      EXIT WHEN length(payload) >= 7;
      b := get_byte(bytes, i);
      IF b < 248 THEN                       -- 248 = 31 * 8: unbiased modulo
        payload := payload || substr(alphabet, (b % 31) + 1, 1);
      END IF;
    END LOOP;
  END LOOP;
  FOR i IN 1..7 LOOP
    s := (s + i * (position(substr(payload, i, 1) IN alphabet) - 1)) % 31;
  END LOOP;
  -- Solve 8 * c ≡ -s (mod 31); 4 is the inverse of 8 modulo 31.
  check_value := ((((31 - s) % 31) * 4) % 31);
  RETURN 'CU-' || substr(payload, 1, 4) || '-' || substr(payload, 5, 3) || substr(alphabet, check_value + 1, 1);
END;
$$ LANGUAGE plpgsql VOLATILE;

DO $$
DECLARE
  u record;
  candidate text;
BEGIN
  FOR u IN SELECT id FROM "users" WHERE "customer_code" IS NULL LOOP
    LOOP
      candidate := phase4_generate_customer_code();
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "users" WHERE "customer_code" = candidate);
    END LOOP;
    UPDATE "users" SET "customer_code" = candidate WHERE id = u.id;
  END LOOP;
END $$;

DROP FUNCTION phase4_generate_customer_code();

ALTER TABLE "users" ALTER COLUMN "customer_code" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_customer_code_key" ON "users"("customer_code");

ALTER TABLE "users"
  ADD CONSTRAINT "users_customer_code_format"
  CHECK ("customer_code" ~ '^CU-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$');
