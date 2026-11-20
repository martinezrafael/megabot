-- Desfaz 20261120120000_whatsapp_token_envelope. ATENÇÃO: apaga os tokens cifrados (reconecte os números).
ALTER TABLE "whatsapp_connections" DROP CONSTRAINT IF EXISTS "whatsapp_connections_token_fields_check";
ALTER TABLE "whatsapp_connections"
  DROP COLUMN IF EXISTS "access_token_envelope",
  DROP COLUMN IF EXISTS "token_key_id",
  DROP COLUMN IF EXISTS "token_updated_at";
