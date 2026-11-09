-- Reversão manual (Rollback script)
DROP POLICY IF EXISTS tenant_isolation_policy ON "memberships";
ALTER TABLE "memberships" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "memberships" DISABLE ROW LEVEL SECURITY;
DROP FUNCTION IF EXISTS current_tenant_id();