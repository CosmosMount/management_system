-- Generation 2 of the guard is installed atomically while all tables that can
-- change the invariant are write-locked. It remains as a permanent database
-- invariant and is intentionally unaffected by the compatibility cleanup for
-- the earlier deployment-only trigger names.
LOCK TABLE
  "Task",
  "Account",
  "AccountIdentity",
  "SystemRoleAssignment"
IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION "assert_usable_global_approval_administrator_v2"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(2026080301);

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

CREATE CONSTRAINT TRIGGER "Task_usable_global_administrator_insert_guard_v2"
AFTER INSERT ON "Task"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_usable_global_approval_administrator_v2"();

CREATE CONSTRAINT TRIGGER "Account_usable_global_administrator_guard_v2"
AFTER UPDATE OR DELETE ON "Account"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_usable_global_approval_administrator_v2"();

CREATE CONSTRAINT TRIGGER "AccountIdentity_usable_global_administrator_guard_v2"
AFTER UPDATE OR DELETE ON "AccountIdentity"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_usable_global_approval_administrator_v2"();

CREATE CONSTRAINT TRIGGER "SystemRoleAssignment_global_administrator_update_guard_v2"
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
EXECUTE FUNCTION "assert_usable_global_approval_administrator_v2"();

CREATE CONSTRAINT TRIGGER "SystemRoleAssignment_global_administrator_delete_guard_v2"
AFTER DELETE ON "SystemRoleAssignment"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD.role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
  AND btrim(OLD.team) = ''
  AND btrim(OLD."techGroup") = ''
)
EXECUTE FUNCTION "assert_usable_global_approval_administrator_v2"();

-- Repeat the check after trigger installation while the table locks are still
-- held. This closes the check/install race for pre-existing writers.
DO $$
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
      'atomic global approval administrator guard blocked: Task data exists but no ACTIVE global administrator with a default-tenant Feishu openId is available';
  END IF;
END $$;
