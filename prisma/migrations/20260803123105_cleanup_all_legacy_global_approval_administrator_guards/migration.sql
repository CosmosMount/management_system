-- Compatibility cleanup for databases that applied later cleanup migrations
-- before backfilling the earlier generation-1 guard migrations. Generation-2
-- trigger names are deliberately not touched.
DROP TRIGGER IF EXISTS "Account_global_approval_administrator_guard"
ON "Account";

DROP TRIGGER IF EXISTS "AccountIdentity_global_approval_administrator_guard"
ON "AccountIdentity";

DROP TRIGGER IF EXISTS "SystemRoleAssignment_global_approval_administrator_guard"
ON "SystemRoleAssignment";

DROP TRIGGER IF EXISTS "SystemRoleAssignment_global_administrator_update_guard"
ON "SystemRoleAssignment";

DROP TRIGGER IF EXISTS "SystemRoleAssignment_global_administrator_delete_guard"
ON "SystemRoleAssignment";

DROP TRIGGER IF EXISTS "Task_global_approval_administrator_guard"
ON "Task";

DROP FUNCTION IF EXISTS "assert_usable_global_approval_administrator"();
