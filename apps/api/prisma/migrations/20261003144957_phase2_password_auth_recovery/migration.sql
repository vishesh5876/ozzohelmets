-- DropIndex
DROP INDEX "users_email_key";

-- DropIndex
DROP INDEX "users_mobile_key";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "password_changed_at" TIMESTAMPTZ(3),
ADD COLUMN     "recovery_code_created_at" TIMESTAMPTZ(3),
ADD COLUMN     "recovery_code_hash" TEXT;
