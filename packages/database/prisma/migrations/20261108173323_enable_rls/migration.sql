-- 1. Função para capturar o tenant_id da sessão com SECURITY INVOKER
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.tenant_id', true), '')::UUID;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER;

-- 2. Habilitar e FORÇAR RLS na tabela memberships
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;

-- 3. Remover policy anterior se existir
DROP POLICY IF EXISTS tenant_isolation_policy ON "memberships";

-- 4. Criar policy restritiva usando tenant_id (nome real da coluna no banco)
CREATE POLICY tenant_isolation_policy ON "memberships"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());