-- Reversão manual (Rollback script)
DROP TABLE IF EXISTS "verifications";
DROP TABLE IF EXISTS "accounts";
DROP TABLE IF EXISTS "sessions";
ALTER TABLE "users" DROP COLUMN IF EXISTS "image";
ALTER TABLE "users" DROP COLUMN IF EXISTS "email_verified";
