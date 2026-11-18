-- Reversão manual da T1.6. Depois dela, o job outbound-message deixa de achar a tabela:
-- reverta o código junto.
DROP TABLE IF EXISTS "whatsapp_rate_limits";
