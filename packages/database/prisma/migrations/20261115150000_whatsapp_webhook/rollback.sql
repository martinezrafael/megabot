-- Reversão manual (Rollback script). As policies saem junto com as tabelas.
DROP TABLE IF EXISTS "webhook_events";
DROP TABLE IF EXISTS "whatsapp_connections";
DROP FUNCTION IF EXISTS current_app_phone_number_id();
