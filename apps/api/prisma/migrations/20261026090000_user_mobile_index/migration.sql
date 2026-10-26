-- Mobile number collected at sign-up: support looks customers up by it (exact, E.164).
-- Additive only.
CREATE INDEX "users_mobile_idx" ON "users"("mobile");
