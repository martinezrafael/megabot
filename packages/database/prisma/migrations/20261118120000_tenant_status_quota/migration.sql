-- T1.5 — Status do tenant e limite de conversas por mês
--
-- O job `inbound-message` decide se aciona o agente olhando (ADR 0011):
--   * o tenant está ativo?            -> tenants.status
--   * ainda há cota de conversas?     -> tenants.conversation_limit_per_month
--
-- Os planos e a cobrança (ADR 0007) ainda não existem; por isso o limite fica direto no tenant.
-- NULL = sem limite (valor padrão). Quando houver planos, uma task futura passa a preencher
-- esta coluna a partir do plano do tenant (ou a substitui).
--
-- `tenants` não tem RLS (igual às outras tabelas globais); nada muda nas policies.

ALTER TABLE "tenants"
  ADD COLUMN "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  ADD COLUMN "conversation_limit_per_month" INTEGER;

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_status_check" CHECK ("status" IN ('active', 'suspended')),
  ADD CONSTRAINT "tenants_conversation_limit_check"
    CHECK ("conversation_limit_per_month" IS NULL OR "conversation_limit_per_month" >= 0);

-- A cota conta as conversas (janelas) abertas no mês: esta consulta filtra por tenant e por
-- início da janela, e o índice existente (tenant, contato, início) não serve para ela.
CREATE INDEX "conversations_tenant_id_window_started_at_idx"
  ON "conversations" ("tenant_id", "window_started_at");
