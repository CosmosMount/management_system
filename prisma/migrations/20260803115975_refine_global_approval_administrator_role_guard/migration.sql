-- The Task migration retires GROUP_LEADER rows and then alters
-- SystemRoleAssignment in the same transaction. Do not enqueue deferred events
-- for those unrelated rows; only changes entering or leaving a global role can
-- affect the usable-administrator invariant.
CREATE OR REPLACE FUNCTION "assert_usable_global_approval_administrator"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Task" LIMIT 1)
     AND NOT EXISTS (
       SELECT 1
       FROM "Account" account
       JOIN "SystemRoleAssignment" assignment
         ON assignment."accountId" = account.id
       WHERE account."projectAccessStatus" = 'ACTIVE'
         AND assignment."revokedAt" IS NULL
         AND assignment.role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
         AND btrim(assignment.team) = ''
         AND btrim(assignment."techGroup") = ''
         AND EXISTS (
           SELECT 1
           FROM "AccountIdentity" identity
           WHERE identity."accountId" = account.id
             AND identity.provider = 'FEISHU'
             AND identity."tenantId" = 'default'
             AND length(btrim(coalesce(identity."openId", ''))) > 0
         )
     ) THEN
    RAISE EXCEPTION
      'usable global approval administrator invariant violated: Task data requires an ACTIVE global administrator with a default-tenant Feishu openId'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "SystemRoleAssignment_global_approval_administrator_guard"
ON "SystemRoleAssignment";

CREATE CONSTRAINT TRIGGER "SystemRoleAssignment_global_administrator_update_guard"
AFTER UPDATE ON "SystemRoleAssignment"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  (
    OLD.role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
    AND btrim(OLD.team) = ''
    AND btrim(OLD."techGroup") = ''
  )
  OR
  (
    NEW.role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
    AND btrim(NEW.team) = ''
    AND btrim(NEW."techGroup") = ''
  )
)
EXECUTE FUNCTION "assert_usable_global_approval_administrator"();

CREATE CONSTRAINT TRIGGER "SystemRoleAssignment_global_administrator_delete_guard"
AFTER DELETE ON "SystemRoleAssignment"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD.role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
  AND btrim(OLD.team) = ''
  AND btrim(OLD."techGroup") = ''
)
EXECUTE FUNCTION "assert_usable_global_approval_administrator"();
