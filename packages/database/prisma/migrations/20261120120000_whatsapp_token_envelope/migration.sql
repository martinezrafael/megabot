-- T1.7: token de acesso do WhatsApp POR NÚMERO, cifrado com criptografia de envelope (ADR 0018).
-- A coluna guarda só o envelope (DEK embrulhada + iv + tag + texto cifrado); a KEK nunca vai ao banco.
-- As policies de RLS existentes continuam valendo (colunas novas, mesma tabela).
ALTER TABLE "whatsapp_connections"
  ADD COLUMN "access_token_envelope" TEXT,
  ADD COLUMN "token_key_id" TEXT,
  ADD COLUMN "token_updated_at" TIMESTAMPTZ(6);

-- Ou os três campos existem, ou nenhum: evita linha com envelope sem id de chave.
ALTER TABLE "whatsapp_connections"
  ADD CONSTRAINT "whatsapp_connections_token_fields_check"
  CHECK (
    ("access_token_envelope" IS NULL AND "token_key_id" IS NULL AND "token_updated_at" IS NULL)
    OR ("access_token_envelope" IS NOT NULL AND "token_key_id" IS NOT NULL AND "token_updated_at" IS NOT NULL)
  );
