-- The temporary constraint has now protected the complete irreversible
-- migration window and 20260803123000 has repeated the final invariant check.
-- Runtime services take over administrator-set locking and approval-recipient
-- validation after migrate deploy completes.
DROP TRIGGER IF EXISTS "Account_global_approval_administrator_guard"
ON "Account";

DROP TRIGGER IF EXISTS "AccountIdentity_global_approval_administrator_guard"
ON "AccountIdentity";

DROP TRIGGER IF EXISTS "SystemRoleAssignment_global_approval_administrator_guard"
ON "SystemRoleAssignment";

DROP FUNCTION IF EXISTS "assert_usable_global_approval_administrator"();
