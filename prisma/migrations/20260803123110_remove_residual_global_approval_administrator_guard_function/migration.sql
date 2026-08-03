-- Environments that had already applied the original cleanup migration may
-- have recreated the shared function while backfilling the earlier narrowed
-- role-guard migration. Keep that upgrade path idempotently clean.
DROP FUNCTION IF EXISTS "assert_usable_global_approval_administrator"();
