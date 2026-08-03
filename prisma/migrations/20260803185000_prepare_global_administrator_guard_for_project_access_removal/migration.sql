-- Project access disabling is being removed, so account status can no longer
-- participate in the permanent global approval administrator invariant.
-- Serialize every table that can change the invariant while replacing the
-- generation-2 function and removing the status-only Account update trigger.
BEGIN;

LOCK TABLE
  "Task",
  "Account",
  "AccountIdentity",
  "SystemRoleAssignment"
IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS "Account_usable_global_administrator_update_guard_v2"
ON "Account";

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
       WHERE assignment."revokedAt" IS NULL
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
      'usable global approval administrator invariant violated: Task data requires a global administrator with a default-tenant Feishu openId'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Task" LIMIT 1)
     AND NOT EXISTS (
       SELECT 1
       FROM "Account" account
       JOIN "SystemRoleAssignment" assignment
         ON assignment."accountId" = account.id
       WHERE assignment."revokedAt" IS NULL
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
      'global approval administrator guard migration blocked: Task data exists but no global administrator with a default-tenant Feishu openId is available';
  END IF;
END $$;

COMMIT;
