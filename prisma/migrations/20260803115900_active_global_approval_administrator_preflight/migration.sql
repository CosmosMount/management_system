-- This read-only deployment gate intentionally sorts immediately before
-- 20260803120000_task_global_visibility_participants_admin_approval.
-- It prevents that destructive schema migration from being committed when
-- the fixed administrator-only workflow would have no usable approver.
--
-- 20260803120000 may already be applied in some environments, so its immutable
-- migration history is not rewritten. The later 20260803123000 guard remains
-- as defense in depth for environments that already crossed that boundary.
DO $$
DECLARE
  task_count integer;
  active_administrator_count integer;
  feishu_reachable_administrator_count integer;
BEGIN
  SELECT count(*) INTO task_count FROM "Task";
  IF task_count = 0 THEN
    RETURN;
  END IF;

  SELECT count(DISTINCT account.id)
  INTO active_administrator_count
  FROM "Account" account
  JOIN "SystemRoleAssignment" assignment
    ON assignment."accountId" = account.id
  WHERE account."projectAccessStatus" = 'ACTIVE'
    AND assignment."revokedAt" IS NULL
    AND assignment.role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
    AND btrim(assignment.team) = ''
    AND btrim(assignment."techGroup") = '';

  SELECT count(DISTINCT account.id)
  INTO feishu_reachable_administrator_count
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
    );

  IF active_administrator_count = 0 THEN
    RAISE EXCEPTION
      'global approval administrator preflight blocked: Task data exists but no ACTIVE global administrator account is available';
  END IF;
  IF feishu_reachable_administrator_count = 0 THEN
    RAISE EXCEPTION
      'global approval administrator preflight blocked: active global administrators have no default-tenant Feishu openId';
  END IF;
END $$;
