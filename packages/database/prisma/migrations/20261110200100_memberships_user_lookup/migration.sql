-- Por que esta migration existe?
-- A policy `tenant_isolation_policy` só deixa ver memberships do tenant que está
-- em `app.tenant_id`. Mas, no login, ainda NÃO sabemos o tenant: precisamos
-- descobri-lo a partir do usuário. Esta segunda policy (somente SELECT) libera
-- a leitura das memberships do PRÓPRIO usuário informado em `app.user_id`.
-- Policies permissivas são combinadas com OR, então o isolamento por tenant
-- continua valendo para tudo o mais (INSERT, UPDATE, DELETE e leituras por tenant).

-- 1. Função que lê o usuário da sessão (mesmo padrão de current_tenant_id)
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.user_id', true), '')::UUID;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY INVOKER;

-- 2. Policy de leitura das próprias memberships
DROP POLICY IF EXISTS membership_self_select_policy ON "memberships";

CREATE POLICY membership_self_select_policy ON "memberships"
  FOR SELECT
  USING (user_id = current_app_user_id());
