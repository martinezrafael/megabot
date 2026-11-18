-- Reversão manual da T1.5. Depois dela, o job inbound-message deixa de achar as colunas:
-- reverta o código junto.
DROP INDEX IF EXISTS "conversations_tenant_id_window_started_at_idx";
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_conversation_limit_check";
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_status_check";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "conversation_limit_per_month";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "status";
