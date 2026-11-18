-- T1.4 — Modelo de conversas
--
-- Três tabelas novas (todas com RLS + FORCE, igual a `memberships`):
--   contacts:      quem fala com o tenant (identificado pelo wa_id do WhatsApp).
--   conversations: UMA janela de atendimento de 24h de um contato (ADR 0010/0011: conversa = janela).
--   messages:      mensagens recebidas e enviadas, únicas por (tenant_id, wamid).
--
-- Referências entre as tabelas incluem o tenant_id (chave estrangeira composta): é impossível ligar
-- uma conversa do tenant A a um contato do tenant B, mesmo por engano de código.

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "wa_id" TEXT NOT NULL,
    "profile_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id"),
    -- wa_id = número do WhatsApp só com dígitos (E.164 sem "+"), 7 a 15 dígitos.
    CONSTRAINT "contacts_wa_id_check" CHECK ("wa_id" ~ '^[0-9]{7,15}$')
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "window_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_inbound_at" TIMESTAMPTZ(6) NOT NULL,
    "expired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "conversations_status_check" CHECK ("status" IN ('open', 'expired')),
    CONSTRAINT "conversations_window_check" CHECK ("window_expires_at" > "window_started_at"),
    -- expired_at só existe quando a conversa está expirada.
    CONSTRAINT "conversations_expired_at_check" CHECK (("status" = 'expired') = ("expired_at" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "conversation_id" UUID,
    "direction" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT,
    "content" JSONB,
    "wamid" TEXT,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,
    "delivered_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "messages_direction_check" CHECK ("direction" IN ('inbound', 'outbound')),
    CONSTRAINT "messages_sender_check" CHECK ("sender" IN ('contact', 'bot', 'agent')),
    CONSTRAINT "messages_status_check" CHECK ("status" IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
    -- Recebida <=> remetente é o contato <=> status "received".
    CONSTRAINT "messages_direction_sender_check" CHECK (("direction" = 'inbound') = ("sender" = 'contact')),
    CONSTRAINT "messages_inbound_status_check" CHECK (("direction" = 'inbound') = ("status" = 'received')),
    -- Mensagem recebida SEMPRE tem wamid e conversa (a janela que ela abriu ou renovou).
    CONSTRAINT "messages_inbound_refs_check" CHECK ("direction" = 'outbound' OR ("wamid" IS NOT NULL AND "conversation_id" IS NOT NULL))
);

-- CreateIndex
-- Um contato por número em cada tenant (o upsert do webhook depende disto).
CREATE UNIQUE INDEX "contacts_tenant_id_wa_id_key" ON "contacts"("tenant_id", "wa_id");

-- CreateIndex
-- Necessário para as chaves estrangeiras compostas (tenant_id, contact_id) das tabelas filhas.
CREATE UNIQUE INDEX "contacts_tenant_id_id_key" ON "contacts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_tenant_id_id_key" ON "conversations"("tenant_id", "id");

-- CreateIndex
-- Histórico de conversas de um contato, da mais recente para a mais antiga.
CREATE INDEX "conversations_tenant_id_contact_id_window_started_at_idx" ON "conversations"("tenant_id", "contact_id", "window_started_at");

-- CreateIndex
-- Varredura de expiração: "quais conversas abertas já passaram do prazo?".
CREATE INDEX "conversations_tenant_id_status_window_expires_at_idx" ON "conversations"("tenant_id", "status", "window_expires_at");

-- CreateIndex
-- REGRA DE OURO (ADR 0010, decisão 1): no máximo UMA janela ativa por contato.
-- Índice parcial: o Prisma não o declara; ele existe só aqui, no SQL à mão.
CREATE UNIQUE INDEX "conversations_one_open_per_contact_key" ON "conversations"("tenant_id", "contact_id") WHERE "status" = 'open';

-- CreateIndex
-- A CHAVE DE IDEMPOTÊNCIA: o mesmo wamid nunca entra duas vezes no mesmo tenant.
-- (NULLs não colidem: mensagens enviadas ainda sem wamid podem coexistir.)
CREATE UNIQUE INDEX "messages_tenant_id_wamid_key" ON "messages"("tenant_id", "wamid");

-- CreateIndex
-- Linha do tempo de uma conversa.
CREATE INDEX "messages_tenant_id_conversation_id_sent_at_idx" ON "messages"("tenant_id", "conversation_id", "sent_at");

-- CreateIndex
-- Histórico de um contato.
CREATE INDEX "messages_tenant_id_contact_id_sent_at_idx" ON "messages"("tenant_id", "contact_id", "sent_at");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- conversation_id é opcional (template enviado fora de janela, no futuro): com NULL a FK não é checada.
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS (usa current_tenant_id(), criada na migration enable_rls)
-- ---------------------------------------------------------------------------

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contacts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON "contacts";
CREATE POLICY tenant_isolation_policy ON "contacts"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_policy ON "conversations";
CREATE POLICY tenant_isolation_policy ON "conversations"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_policy ON "messages";
CREATE POLICY tenant_isolation_policy ON "messages"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
