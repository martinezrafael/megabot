-- Reversão manual (Rollback script)
DROP POLICY IF EXISTS membership_self_select_policy ON "memberships";
DROP FUNCTION IF EXISTS current_app_user_id();
