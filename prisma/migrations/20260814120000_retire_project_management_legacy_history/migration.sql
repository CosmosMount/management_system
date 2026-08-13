-- Archive retired project-management history before narrowing the runtime
-- schema. This migration never maps an active legacy role to a new role and
-- never writes notification records.

BEGIN;

-- Freeze every source of facts before the blocker check and archive SELECTs.
-- SHARE ROW EXCLUSIVE allows production reads to continue but serializes this
-- migration with all role, membership and completion writes. Keep this order
-- stable to avoid cross-table lock inversions during deploys.
LOCK TABLE
  "SystemRoleAssignment",
  "TaskMember",
  "WorkSegment"
IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  active_legacy_system_role_count INTEGER;
  active_legacy_task_role_count INTEGER;
BEGIN
  SELECT count(*) INTO active_legacy_system_role_count
  FROM "SystemRoleAssignment"
  WHERE "revokedAt" IS NULL
    AND role::TEXT NOT IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR');

  SELECT count(*) INTO active_legacy_task_role_count
  FROM "TaskMember"
  WHERE "removedAt" IS NULL
    AND role::TEXT NOT IN ('OWNER', 'PARTICIPANT');

  IF active_legacy_system_role_count + active_legacy_task_role_count > 0 THEN
    RAISE EXCEPTION
      'project management legacy history retirement blocked: active_legacy_system_roles=% active_legacy_task_roles=%; revoke or end them explicitly before deployment',
      active_legacy_system_role_count,
      active_legacy_task_role_count;
  END IF;
END $$;

INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", before, after,
  reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:pm-history:v1:system-role:' || assignment.id,
  'account.legacy_project_role.archived',
  'Account',
  assignment."accountId",
  jsonb_build_object(
    'assignmentId', assignment.id,
    'accountId', assignment."accountId",
    'role', assignment.role::TEXT,
    'team', assignment.team,
    'techGroup', assignment."techGroup",
    'grantedByAccountId', assignment."grantedByAccountId",
    'revokedByAccountId', assignment."revokedByAccountId",
    'createdAt', assignment."createdAt",
    'revokedAt', assignment."revokedAt"
  ),
  jsonb_build_object('archived', true, 'assignmentDeleted', true),
  '已撤销旧项目角色归档后删除历史行；不改变当前权限；不发送用户通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "SystemRoleAssignment" assignment
WHERE assignment."revokedAt" IS NOT NULL
  AND assignment.role::TEXT NOT IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR');

INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", "taskId", before, after,
  reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:pm-history:v1:task-member:' || member.id,
  'pm.task.legacy_member_role.archived',
  'TaskMember',
  member.id,
  member."taskId",
  jsonb_build_object(
    'taskId', member."taskId",
    'personId', member."personId",
    'role', member.role::TEXT,
    'createdByAccountId', member."createdByAccountId",
    'createdAt', member."createdAt",
    'removedAt', member."removedAt"
  ),
  jsonb_build_object('archived', true, 'memberRowDeleted', true),
  '已结束旧 Task 成员角色归档后删除历史行；不改变当前权限；不发送用户通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "TaskMember" member
WHERE member."removedAt" IS NOT NULL
  AND member.role::TEXT NOT IN ('OWNER', 'PARTICIPANT');

-- completionPercent may already be absent when a deployment retry reaches an
-- environment whose first transaction committed but migration bookkeeping was
-- repaired separately. Only reference the column when it exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'WorkSegment'
      AND column_name = 'completionPercent'
  ) THEN
    EXECUTE $archive$
      INSERT INTO "DomainAuditEvent" (
        id, action, "entityType", "entityId", "taskId", before, after,
        reason, "requestId", source, "schemaVersion", "createdAt"
      )
      SELECT
        'migration:pm-history:v1:segment-completion:' || segment.id,
        'pm.segment.legacy_completion_percent.archived',
        'WorkSegment',
        segment.id,
        segment."taskId",
        jsonb_build_object(
          'taskId', segment."taskId",
          'personId', segment."personId",
          'completionPercent', segment."completionPercent",
          'type', segment.type::TEXT,
          'status', segment.status::TEXT,
          'createdAt', segment."createdAt",
          'updatedAt', segment."updatedAt"
        ),
        jsonb_build_object('archived', true, 'columnRemoved', true),
        '旧投入完成比例归档后删除字段；不发送用户通知',
        '',
        'MIGRATION',
        1,
        CURRENT_TIMESTAMP
      FROM "WorkSegment" segment
      WHERE segment."completionPercent" IS NOT NULL
    $archive$;
  END IF;
END $$;

-- The permanent global-administrator guards embed enum constants in their
-- WHEN clauses. Recreate only the two role-assignment triggers around the enum
-- rebuild; the shared invariant function and the Account/Identity/Task guards
-- remain active throughout the transaction.
DROP TRIGGER IF EXISTS "SystemRoleAssignment_global_administrator_delete_guard_v2"
ON "SystemRoleAssignment";
DROP TRIGGER IF EXISTS "SystemRoleAssignment_global_administrator_update_guard_v2"
ON "SystemRoleAssignment";

DELETE FROM "SystemRoleAssignment"
WHERE "revokedAt" IS NOT NULL
  AND role::TEXT NOT IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR');

DELETE FROM "TaskMember"
WHERE "removedAt" IS NOT NULL
  AND role::TEXT NOT IN ('OWNER', 'PARTICIPANT');

ALTER TABLE "TaskMember"
  DROP CONSTRAINT IF EXISTS "TaskMember_active_role_check";
ALTER TABLE "SystemRoleAssignment"
  DROP CONSTRAINT IF EXISTS "SystemRoleAssignment_scope_required_check",
  DROP CONSTRAINT IF EXISTS "SystemRoleAssignment_active_global_role_check";

ALTER TABLE "TaskMember"
  ALTER COLUMN role TYPE TEXT USING role::TEXT;
DROP TYPE "TaskMemberRole";
CREATE TYPE "TaskMemberRole" AS ENUM ('OWNER', 'PARTICIPANT');
ALTER TABLE "TaskMember"
  ALTER COLUMN role TYPE "TaskMemberRole" USING role::"TaskMemberRole";

ALTER TABLE "SystemRoleAssignment"
  ALTER COLUMN role TYPE TEXT USING role::TEXT;
DROP TYPE "ProjectManagementSystemRole";
CREATE TYPE "ProjectManagementSystemRole" AS ENUM (
  'SUPER_ADMINISTRATOR',
  'PROJECT_ADMINISTRATOR'
);
ALTER TABLE "SystemRoleAssignment"
  ALTER COLUMN role TYPE "ProjectManagementSystemRole"
  USING role::"ProjectManagementSystemRole";

ALTER TABLE "TaskMember"
  ADD CONSTRAINT "TaskMember_active_role_check"
    CHECK ("removedAt" IS NOT NULL OR role IN ('OWNER', 'PARTICIPANT'));

ALTER TABLE "SystemRoleAssignment"
  ADD CONSTRAINT "SystemRoleAssignment_scope_required_check"
    CHECK (
      "revokedAt" IS NOT NULL
      OR (length(btrim(team)) = 0 AND length(btrim("techGroup")) = 0)
    ),
  ADD CONSTRAINT "SystemRoleAssignment_active_global_role_check"
    CHECK (
      "revokedAt" IS NOT NULL
      OR (
        role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
        AND length(btrim(team)) = 0
        AND length(btrim("techGroup")) = 0
      )
    );

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
  OR (
    NEW.role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
    AND btrim(NEW.team) = ''
    AND btrim(NEW."techGroup") = ''
  )
)
EXECUTE FUNCTION "assert_usable_global_approval_administrator_v2"();

ALTER TABLE "WorkSegment"
  DROP CONSTRAINT IF EXISTS "WorkSegment_completion_range_check",
  DROP COLUMN IF EXISTS "completionPercent";

-- PostgreSQL truncated the original quoted index name at 63 bytes, while the
-- current Prisma schema uses its own stable shortened form. Normalize the
-- catalog name so a clean full migration chain has zero schema drift.
ALTER INDEX IF EXISTS
  "ProjectEstablishmentRequest_submittedByAccountId_idempotencyKey"
  RENAME TO
  "ProjectEstablishmentRequest_submittedByAccountId_idempotenc_key";

DO $$
DECLARE
  task_role_values TEXT[];
  system_role_values TEXT[];
  completion_column_count INTEGER;
  audit_trigger_count INTEGER;
BEGIN
  SELECT array_agg(enumlabel ORDER BY enumsortorder)
  INTO task_role_values
  FROM pg_enum
  WHERE enumtypid = '"TaskMemberRole"'::regtype;

  SELECT array_agg(enumlabel ORDER BY enumsortorder)
  INTO system_role_values
  FROM pg_enum
  WHERE enumtypid = '"ProjectManagementSystemRole"'::regtype;

  SELECT count(*) INTO completion_column_count
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'WorkSegment'
    AND column_name = 'completionPercent';

  SELECT count(*) INTO audit_trigger_count
  FROM pg_trigger
  WHERE tgrelid = '"DomainAuditEvent"'::regclass
    AND tgname IN (
      'DomainAuditEvent_prevent_update',
      'DomainAuditEvent_prevent_delete'
    )
    AND NOT tgisinternal;

  IF task_role_values IS DISTINCT FROM ARRAY['OWNER', 'PARTICIPANT']::TEXT[] THEN
    RAISE EXCEPTION 'TaskMemberRole final values are invalid: %', task_role_values;
  END IF;
  IF system_role_values IS DISTINCT FROM ARRAY[
    'SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR'
  ]::TEXT[] THEN
    RAISE EXCEPTION
      'ProjectManagementSystemRole final values are invalid: %',
      system_role_values;
  END IF;
  IF completion_column_count <> 0 THEN
    RAISE EXCEPTION 'WorkSegment.completionPercent was not removed';
  END IF;
  IF audit_trigger_count <> 2 THEN
    RAISE EXCEPTION 'DomainAuditEvent append-only guards are incomplete';
  END IF;
END $$;

COMMIT;
