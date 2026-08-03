-- Remove the final generation-1 Task trigger before the older compatibility
-- cleanup migration drops its shared function. This migration sorts before
-- 20260803123100 in both fresh and lower-numbered backfill deployments.
DROP TRIGGER IF EXISTS "Task_global_approval_administrator_guard"
ON "Task";
