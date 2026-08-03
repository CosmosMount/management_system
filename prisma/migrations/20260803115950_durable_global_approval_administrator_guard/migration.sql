-- Keep the usable-global-administrator invariant true across the transaction
-- boundary between the read-only preflight and the irreversible Task migration.
-- This migration intentionally sorts before 20260803120000.
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
      'durable global approval administrator guard blocked: Task data exists but no ACTIVE global administrator with a default-tenant Feishu openId is available';
  END IF;
END $$;

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

CREATE CONSTRAINT TRIGGER "Account_global_approval_administrator_guard"
AFTER INSERT OR UPDATE OR DELETE ON "Account"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_usable_global_approval_administrator"();

CREATE CONSTRAINT TRIGGER "AccountIdentity_global_approval_administrator_guard"
AFTER INSERT OR UPDATE OR DELETE ON "AccountIdentity"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_usable_global_approval_administrator"();

CREATE CONSTRAINT TRIGGER "SystemRoleAssignment_global_approval_administrator_guard"
AFTER INSERT OR UPDATE OR DELETE ON "SystemRoleAssignment"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_usable_global_approval_administrator"();
