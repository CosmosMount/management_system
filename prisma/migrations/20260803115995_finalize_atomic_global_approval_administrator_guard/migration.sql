-- Final pre-main barrier. All generation-2 triggers already exist at this
-- point; this explicit transaction waits for every pre-existing writer, then
-- rechecks the invariant while preventing new writes on all relevant tables.
BEGIN;

LOCK TABLE
  "Task",
  "Account",
  "AccountIdentity",
  "SystemRoleAssignment"
IN SHARE ROW EXCLUSIVE MODE;

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
      'atomic global approval administrator finalization blocked: Task data exists but no ACTIVE global administrator with a default-tenant Feishu openId is available';
  END IF;
END $$;

COMMIT;
