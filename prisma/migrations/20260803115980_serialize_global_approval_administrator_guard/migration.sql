-- Serialize every deferred administrator invariant check with the same lock
-- used by the runtime account service. This closes the write-skew window where
-- concurrent transactions could each remove a different usable administrator.
CREATE OR REPLACE FUNCTION "assert_usable_global_approval_administrator"()
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

-- A deployment that started from an empty database must also reject an old
-- application instance creating the first Task before an administrator exists.
CREATE CONSTRAINT TRIGGER "Task_global_approval_administrator_guard"
AFTER INSERT ON "Task"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_usable_global_approval_administrator"();
