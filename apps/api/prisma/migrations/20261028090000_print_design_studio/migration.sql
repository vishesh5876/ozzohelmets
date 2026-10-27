-- Print Studio: a design may be built from layers in the admin (studio_document) instead of one
-- uploaded artwork file. Additive: existing rows keep their artwork and render exactly as before.
-- Studio designs reference their image layers by print_artwork_files id inside the document; the
-- service verifies every referenced file by SHA-256 before printing (as for base artwork).
ALTER TABLE "print_designs" ALTER COLUMN "base_artwork_file_id" DROP NOT NULL;
ALTER TABLE "print_designs" ALTER COLUMN "artwork_type" DROP NOT NULL;
ALTER TABLE "print_designs" ADD COLUMN "studio_document" JSONB;
ALTER TABLE "print_designs" ADD CONSTRAINT "print_designs_artwork_or_studio_check" CHECK (
  ("studio_document" IS NULL AND "base_artwork_file_id" IS NOT NULL AND "artwork_type" IS NOT NULL)
  OR ("studio_document" IS NOT NULL AND "base_artwork_file_id" IS NULL AND "cover_artwork_file_id" IS NULL)
);
