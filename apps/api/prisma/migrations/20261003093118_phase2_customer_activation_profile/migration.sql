-- CreateEnum
CREATE TYPE "BloodGroup" AS ENUM ('A_POSITIVE', 'A_NEGATIVE', 'B_POSITIVE', 'B_NEGATIVE', 'AB_POSITIVE', 'AB_NEGATIVE', 'O_POSITIVE', 'O_NEGATIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('FEMALE', 'MALE', 'NON_BINARY', 'OTHER', 'PREFER_NOT_TO_SAY');

-- AlterTable
ALTER TABLE "helmets" ADD COLUMN     "activation_locked_until" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_login_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "customer_refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "replaced_by" UUID,
    "user_agent" VARCHAR(255),
    "ip_hash" CHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "helmet_id" UUID,
    "name" VARCHAR(120),
    "blood_group" "BloodGroup",
    "gender" "Gender",
    "organ_donor" BOOLEAN,
    "date_of_birth_ciphertext" TEXT,
    "allergies_ciphertext" TEXT,
    "medical_conditions_ciphertext" TEXT,
    "medications_ciphertext" TEXT,
    "emergency_notes_ciphertext" TEXT,
    "photo_key" VARCHAR(255),
    "photo_content_type" VARCHAR(40),
    "photo_updated_at" TIMESTAMPTZ(3),
    "emergency_profile_enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "emergency_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_contacts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "relationship" VARCHAR(60) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "alternate_phone" VARCHAR(20),
    "priority" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_visibility" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "show_name" BOOLEAN NOT NULL DEFAULT false,
    "show_photo" BOOLEAN NOT NULL DEFAULT false,
    "show_blood_group" BOOLEAN NOT NULL DEFAULT false,
    "show_date_of_birth" BOOLEAN NOT NULL DEFAULT false,
    "show_gender" BOOLEAN NOT NULL DEFAULT false,
    "show_allergies" BOOLEAN NOT NULL DEFAULT false,
    "show_medical_conditions" BOOLEAN NOT NULL DEFAULT false,
    "show_medications" BOOLEAN NOT NULL DEFAULT false,
    "show_emergency_notes" BOOLEAN NOT NULL DEFAULT false,
    "show_organ_donor" BOOLEAN NOT NULL DEFAULT false,
    "show_emergency_contacts" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "emergency_visibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_refresh_tokens_token_hash_key" ON "customer_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "customer_refresh_tokens_user_id_idx" ON "customer_refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "customer_refresh_tokens_family_id_idx" ON "customer_refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "emergency_profiles_user_id_idx" ON "emergency_profiles"("user_id");

-- CreateIndex
CREATE INDEX "emergency_contacts_user_id_is_active_idx" ON "emergency_contacts"("user_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "emergency_visibility_user_id_key" ON "emergency_visibility"("user_id");

-- AddForeignKey
ALTER TABLE "customer_refresh_tokens" ADD CONSTRAINT "customer_refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_profiles" ADD CONSTRAINT "emergency_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_profiles" ADD CONSTRAINT "emergency_profiles_helmet_id_fkey" FOREIGN KEY ("helmet_id") REFERENCES "helmets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_visibility" ADD CONSTRAINT "emergency_visibility_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Hand-written additions ───

-- One default (helmet_id IS NULL) emergency profile per customer; at most one override per helmet.
CREATE UNIQUE INDEX "emergency_profiles_one_default_per_user"
  ON "emergency_profiles" ("user_id") WHERE "helmet_id" IS NULL;
CREATE UNIQUE INDEX "emergency_profiles_one_per_user_helmet"
  ON "emergency_profiles" ("user_id", "helmet_id") WHERE "helmet_id" IS NOT NULL;

-- Contact priorities are unique among a customer's active contacts (1 = called first).
CREATE UNIQUE INDEX "emergency_contacts_active_priority_unique"
  ON "emergency_contacts" ("user_id", "priority") WHERE "is_active";
ALTER TABLE "emergency_contacts"
  ADD CONSTRAINT "emergency_contacts_priority_range" CHECK ("priority" BETWEEN 1 AND 100);

-- An enabled profile must have a name (application also enforces contacts + privacy review).
ALTER TABLE "emergency_profiles"
  ADD CONSTRAINT "emergency_profiles_enabled_requires_name"
  CHECK (NOT "emergency_profile_enabled" OR ("name" IS NOT NULL AND length(trim("name")) > 0));

-- The failed-attempt counter can never go negative.
ALTER TABLE "helmets"
  ADD CONSTRAINT "helmets_attempts_non_negative" CHECK ("activation_attempts" >= 0);
