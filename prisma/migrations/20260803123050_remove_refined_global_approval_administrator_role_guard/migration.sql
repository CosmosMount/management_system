-- The post-migration administrator check has succeeded. Remove the narrowed
-- role triggers before the general deployment-guard cleanup drops the shared
-- trigger function.
DROP TRIGGER IF EXISTS "SystemRoleAssignment_global_administrator_update_guard"
ON "SystemRoleAssignment";

DROP TRIGGER IF EXISTS "SystemRoleAssignment_global_administrator_delete_guard"
ON "SystemRoleAssignment";
