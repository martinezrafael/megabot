-- T1.2 — Webhook de entrada do WhatsApp
--
-- Duas tabelas novas:
--   whatsapp_connections: qual número do WhatsApp (phone_number_id) pertence a qual tenant.
--   webhook_events:       caixa de entrada dos eventos recebidos (idempotente por tenant + event_key).
--
-- Ambas têm RLS com FORCE, igual a `memberships`.

-- CreateTable
CREATE TABLE "whatsapp_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "display_phone_number" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "whatsapp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "wamid" TEXT,
    "status" TEXT,
    "event_at" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL,
    "process_status" TEXT NOT NULL DEFAULT 'pending',
    "processed_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_events_kind_check" CHECK ("kind" IN ('message', 'status', 'error')),
    CONSTRAINT "webhook_events_process_status_check" CHECK ("process_status" IN ('pending', 'processed', 'failed'))
);

-- CreateIndex
-- Um número de WhatsApp pertence a UM tenant (global, não por tenant).
CREATE UNIQUE INDEX "whatsapp_connections_phone_number_id_key" ON "whatsapp_connections"("phone_number_id");

-- CreateIndex
CREATE INDEX "whatsapp_connections_tenant_id_idx" ON "whatsapp_connections"("tenant_id");

-- CreateIndex
-- A CHAVE DE IDEMPOTÊNCIA: reenvio do mesmo evento cai aqui e é ignorado (ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX "webhook_events_tenant_id_event_key_key" ON "webhook_events"("tenant_id", "event_key");

-- CreateIndex
-- Fila de trabalho: "me dê os eventos pendentes deste tenant, do mais antigo para o mais novo".
CREATE INDEX "webhook_events_tenant_id_process_status_received_at_idx" ON "webhook_events"("tenant_id", "process_status", "received_at");

-- CreateIndex
CREATE INDEX "webhook_events_tenant_id_wamid_idx" ON "webhook_events"("tenant_id", "wamid");

-- AddForeignKey
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

-- Função que lê o número da sessão (mesmo padrão de current_tenant_id / current_app_user_id).
CREATE OR REPLACE FUNCTION current_app_phone_number_id() RETURNS TEXT AS $$
BEGIN
  RETURN NULLIF(current_setting('app.phone_number_id', true), '');
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER;

ALTER TABLE "whatsapp_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_connections" FORCE ROW LEVEL SECURITY;
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_events" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON "whatsapp_connections";
CREATE POLICY tenant_isolation_policy ON "whatsapp_connections"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- Por que esta segunda policy existe? Quando o webhook chega, ainda NÃO sabemos o tenant:
-- só temos o phone_number_id. Ela libera o SELECT da conexão cujo número está em
-- `app.phone_number_id` (mesma ideia de membership_self_select_policy). Só leitura, e só
-- de UMA linha por vez: não dá para listar as conexões de todos os tenants.
DROP POLICY IF EXISTS whatsapp_connection_lookup_policy ON "whatsapp_connections";
CREATE POLICY whatsapp_connection_lookup_policy ON "whatsapp_connections"
  FOR SELECT
  USING (phone_number_id = current_app_phone_number_id());

DROP POLICY IF EXISTS tenant_isolation_policy ON "webhook_events";
CREATE POLICY tenant_isolation_policy ON "webhook_events"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
