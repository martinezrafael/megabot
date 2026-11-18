-- T1.6 — Rate limit de envio por número do WhatsApp (balde de fichas, compartilhado entre workers)
--
-- A Meta limita a vazão de envio por número (padrão: 80 mensagens/segundo). Como pode haver mais de
-- um worker, o controle precisa morar no banco: uma linha por número, atualizada de forma atômica.
--
--   tokens       fichas disponíveis agora (no máximo `burst`)
--   refilled_at  quando `tokens` foi calculado pela última vez; as fichas voltam com o tempo
--
-- O número (`phone_number_id`) é único no sistema (igual a whatsapp_connections).

CREATE TABLE "whatsapp_rate_limits" (
  "phone_number_id" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "tokens" DOUBLE PRECISION NOT NULL,
  "refilled_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "whatsapp_rate_limits_pkey" PRIMARY KEY ("phone_number_id"),
  CONSTRAINT "whatsapp_rate_limits_tokens_check" CHECK ("tokens" >= 0)
);

CREATE INDEX "whatsapp_rate_limits_tenant_id_idx" ON "whatsapp_rate_limits" ("tenant_id");

ALTER TABLE "whatsapp_rate_limits"
  ADD CONSTRAINT "whatsapp_rate_limits_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS (usa current_tenant_id(), criada na migration enable_rls)
ALTER TABLE "whatsapp_rate_limits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_rate_limits" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON "whatsapp_rate_limits";
CREATE POLICY tenant_isolation_policy ON "whatsapp_rate_limits"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
