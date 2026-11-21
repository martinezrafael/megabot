-- T2.4 — Configuração do agente, versionada
--
-- UMA tabela guarda o histórico inteiro. Cada salvamento INSERE uma linha com
-- version = último + 1; nada é atualizado nem apagado. A versão ativa é sempre a de maior
-- `version` do tenant, então não existe flag "ativa" para ficar inconsistente.
--
-- Restaurar uma versão antiga também insere uma versão nova (cópia do conteúdo, com
-- restored_from_version preenchido): o rollback é registrado no histórico, não some dele.

-- CreateTable
CREATE TABLE "agent_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    -- 1, 2, 3... por tenant (ver agent_configs_tenant_id_version_key).
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    -- Tom da conversa; a tela mostra estas quatro opções.
    "tone" TEXT NOT NULL,
    "greeting" TEXT NOT NULL,
    -- Chaves das ferramentas habilitadas. O catálogo (rótulos, descrições, o que já existe de
    -- verdade) vive no código, em packages/database/src/agent-config.ts: ferramenta nova não
    -- deve exigir migration. O banco só garante que não entra lixo (item vazio ou gigante).
    "tools" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Regras de atendimento, na ordem em que a tela mostra.
    "rules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Quem salvou (nulo se a conta for apagada: o histórico continua valendo).
    "created_by_user_id" UUID,
    -- Preenchido quando esta versão nasceu de um "restaurar versão N".
    "restored_from_version" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_configs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_configs_version_check" CHECK ("version" >= 1),
    CONSTRAINT "agent_configs_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
    CONSTRAINT "agent_configs_tone_check" CHECK ("tone" IN ('formal', 'neutro', 'amigavel', 'descontraido')),
    CONSTRAINT "agent_configs_greeting_check" CHECK (length(btrim("greeting")) BETWEEN 1 AND 1000),
    -- `unnest` dentro de CHECK é proibido no Postgres (conta como subquery), então aqui o banco
    -- barra o que dá para barrar com operador de array: poucos itens, nenhum item vazio e tamanho
    -- total limitado. O tamanho de CADA item é validado no código (Zod na API e
    -- normalizeAgentConfigInput no pacote database).
    CONSTRAINT "agent_configs_tools_check" CHECK (
      cardinality("tools") <= 20
      AND NOT ('' = ANY("tools"))
      AND length(array_to_string("tools", ',')) <= 1200
    ),
    CONSTRAINT "agent_configs_rules_check" CHECK (
      cardinality("rules") <= 30
      AND NOT ('' = ANY("rules"))
      AND length(array_to_string("rules", ' ')) <= 15000
    ),
    -- Uma versão não pode ter nascido de si mesma nem de uma versão futura.
    CONSTRAINT "agent_configs_restored_from_check" CHECK ("restored_from_version" IS NULL OR "restored_from_version" < "version")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_configs_tenant_id_version_key" ON "agent_configs"("tenant_id", "version");

-- CreateIndex
CREATE INDEX "agent_configs_tenant_id_created_at_idx" ON "agent_configs"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS (usa current_tenant_id(), criada na migration enable_rls)
-- ---------------------------------------------------------------------------

ALTER TABLE "agent_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_configs" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON "agent_configs";
CREATE POLICY tenant_isolation_policy ON "agent_configs"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
