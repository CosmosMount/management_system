-- Task membership and approval-policy migration.
-- This migration intentionally preserves historical member and approval rows,
-- emits MIGRATION audit events, and never writes notification records.

-- Rebuild instead of ALTER TYPE ... ADD VALUE because Prisma executes the
-- migration in one transaction and PostgreSQL forbids using a newly appended
-- enum value before that transaction commits.
ALTER TYPE "TaskMemberRole" RENAME TO "TaskMemberRole_legacy";
CREATE TYPE "TaskMemberRole" AS ENUM (
  'OWNER',
  'PARTICIPANT',
  'LEAD',
  'MEMBER',
  'REVIEWER',
  'VIEWER'
);
ALTER TABLE "TaskMember"
  ALTER COLUMN role TYPE "TaskMemberRole"
  USING role::text::"TaskMemberRole";
DROP TYPE "TaskMemberRole_legacy";

DO $$
DECLARE
  zero_owner_count integer;
  orphan_segment_count integer;
BEGIN
  SELECT count(*) INTO zero_owner_count
  FROM "Task" task
  WHERE NOT EXISTS (
    SELECT 1
    FROM "TaskMember" member
    WHERE member."taskId" = task.id
      AND member."removedAt" IS NULL
      AND member.role = 'OWNER'
  );

  SELECT count(*) INTO orphan_segment_count
  FROM "WorkSegment" segment
  LEFT JOIN "Task" task ON task.id = segment."taskId"
  LEFT JOIN "Person" person ON person.id = segment."personId"
  WHERE segment."deletedAt" IS NULL
    AND segment."taskId" IS NOT NULL
    AND (task.id IS NULL OR person.id IS NULL);

  IF zero_owner_count > 0 THEN
    RAISE EXCEPTION
      'task membership migration blocked: % Task rows have no active OWNER; run npm run pm:task-access-preflight',
      zero_owner_count;
  END IF;
  IF orphan_segment_count > 0 THEN
    RAISE EXCEPTION
      'task membership migration blocked: % Task-linked WorkSegment rows have orphan references',
      orphan_segment_count;
  END IF;
END $$;

-- Preserve the removed Task-level policy in append-only audit history.
INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", "taskId", before, after,
  reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:task-access:v1:policy:' || task.id,
  'pm.task.approval_policy.retired',
  'Task',
  task.id,
  task.id,
  jsonb_build_object(
    'revisionApprovalMode', task."revisionApprovalMode",
    'allowSelfReview', task."allowSelfReview"
  ),
  jsonb_build_object('approvalPolicy', 'GLOBAL_ADMINISTRATOR_ONLY'),
  'Task 级审批策略退役；改为全局管理员固定审批；不发送用户通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "Task" task
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE "_TaskMemberMigration" AS
WITH active_members AS (
  SELECT
    member.*,
    bool_or(member.role = 'OWNER') OVER (
      PARTITION BY member."taskId", member."personId"
    ) AS has_owner,
    bool_or(member.role IN ('LEAD', 'MEMBER')) OVER (
      PARTITION BY member."taskId", member."personId"
    ) AS has_participant_source
  FROM "TaskMember" member
  WHERE member."removedAt" IS NULL
), ranked_members AS (
  SELECT
    active_members.*,
    row_number() OVER (
      PARTITION BY active_members."taskId", active_members."personId"
      ORDER BY
        CASE
          WHEN active_members.role = 'OWNER' THEN 0
          WHEN active_members.role IN ('LEAD', 'MEMBER') THEN 1
          ELSE 2
        END,
        active_members.id
    ) AS stable_rank
  FROM active_members
)
SELECT
  id,
  "taskId",
  "personId",
  role AS "beforeRole",
  (
    stable_rank = 1
    AND (has_owner OR has_participant_source)
  ) AS "keepActive",
  CASE
    WHEN stable_rank = 1 AND has_owner THEN 'OWNER'::"TaskMemberRole"
    WHEN stable_rank = 1 AND has_participant_source THEN 'PARTICIPANT'::"TaskMemberRole"
    ELSE role
  END AS "afterRole"
FROM ranked_members;

UPDATE "TaskMember" member
SET "removedAt" = CURRENT_TIMESTAMP
FROM "_TaskMemberMigration" migration
WHERE member.id = migration.id
  AND NOT migration."keepActive";

UPDATE "TaskMember" member
SET role = migration."afterRole"
FROM "_TaskMemberMigration" migration
WHERE member.id = migration.id
  AND migration."keepActive"
  AND member.role <> migration."afterRole";

INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", "taskId", before, after,
  reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:task-access:v1:member:' || migration.id,
  'pm.task.member.migrated',
  'TaskMember',
  migration.id,
  migration."taskId",
  jsonb_build_object(
    'personId', migration."personId",
    'role', migration."beforeRole",
    'active', true
  ),
  jsonb_build_object(
    'personId', migration."personId",
    'role', migration."afterRole",
    'active', migration."keepActive"
  ),
  'Task 成员角色归一化；不发送成员变更通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "_TaskMemberMigration" migration
WHERE NOT migration."keepActive"
   OR migration."beforeRole" <> migration."afterRole"
ON CONFLICT (id) DO NOTHING;

DROP TABLE "_TaskMemberMigration";

CREATE TEMP TABLE "_SegmentMembershipBackfill" AS
SELECT
  segment."taskId",
  segment."personId",
  min(segment.id) AS "sourceSegmentId"
FROM "WorkSegment" segment
WHERE segment."deletedAt" IS NULL
  AND segment."taskId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "TaskMember" member
    WHERE member."taskId" = segment."taskId"
      AND member."personId" = segment."personId"
      AND member."removedAt" IS NULL
  )
GROUP BY segment."taskId", segment."personId";

INSERT INTO "TaskMember" (
  id, "taskId", "personId", role, "createdByAccountId", "removedAt", "createdAt"
)
SELECT
  'migration:task-access:v1:segment-member:' || backfill."taskId" || ':' || backfill."personId",
  backfill."taskId",
  backfill."personId",
  'PARTICIPANT',
  NULL,
  NULL,
  CURRENT_TIMESTAMP
FROM "_SegmentMembershipBackfill" backfill;

INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", "taskId", before, after,
  reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:task-access:v1:segment-backfill:' || backfill."taskId" || ':' || backfill."personId",
  'pm.task.member.segment_backfill',
  'TaskMember',
  'migration:task-access:v1:segment-member:' || backfill."taskId" || ':' || backfill."personId",
  backfill."taskId",
  NULL,
  jsonb_build_object(
    'personId', backfill."personId",
    'role', 'PARTICIPANT',
    'sourceSegmentId', backfill."sourceSegmentId",
    'active', true
  ),
  '既有 Task 关联投入持有人回填为参与人；不发送成员变更通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "_SegmentMembershipBackfill" backfill
ON CONFLICT (id) DO NOTHING;

DROP TABLE "_SegmentMembershipBackfill";

CREATE TEMP TABLE "_RetiredProjectRoles" AS
SELECT id, "accountId", role, team, "techGroup"
FROM "SystemRoleAssignment"
WHERE "revokedAt" IS NULL
  AND role NOT IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR');

UPDATE "SystemRoleAssignment" assignment
SET "revokedAt" = CURRENT_TIMESTAMP
FROM "_RetiredProjectRoles" retired
WHERE assignment.id = retired.id;

INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", before, after,
  reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:task-access:v1:system-role:' || retired.id,
  'account.project_role.retired',
  'SystemRoleAssignment',
  retired.id,
  jsonb_build_object(
    'accountId', retired."accountId",
    'role', retired.role,
    'team', retired.team,
    'techGroup', retired."techGroup",
    'active', true
  ),
  jsonb_build_object('active', false, 'revokedAt', CURRENT_TIMESTAMP),
  '非全局项目角色退役；报销角色不受影响；不发送用户通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "_RetiredProjectRoles" retired
ON CONFLICT (id) DO NOTHING;

DROP TABLE "_RetiredProjectRoles";

DROP INDEX "TaskMember_active_task_person_role_key";
CREATE UNIQUE INDEX "TaskMember_active_task_person_key"
  ON "TaskMember"("taskId", "personId")
  WHERE "removedAt" IS NULL;

ALTER TABLE "TaskMember"
  ADD CONSTRAINT "TaskMember_active_role_check"
    CHECK (
      "removedAt" IS NOT NULL
      OR role IN ('OWNER', 'PARTICIPANT')
    );

ALTER TABLE "SystemRoleAssignment"
  ADD CONSTRAINT "SystemRoleAssignment_active_global_role_check"
    CHECK (
      "revokedAt" IS NOT NULL
      OR (
        role IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR')
        AND length(btrim(team)) = 0
        AND length(btrim("techGroup")) = 0
      )
    );

ALTER TABLE "Task"
  DROP COLUMN "revisionApprovalMode",
  DROP COLUMN "allowSelfReview";

DROP TYPE "RevisionApprovalMode";

DO $$
DECLARE
  invalid_role_count integer;
  duplicate_member_count integer;
  zero_owner_count integer;
  unowned_segment_count integer;
  active_retired_role_count integer;
BEGIN
  SELECT count(*) INTO invalid_role_count
  FROM "TaskMember"
  WHERE "removedAt" IS NULL
    AND role NOT IN ('OWNER', 'PARTICIPANT');

  SELECT count(*) INTO duplicate_member_count
  FROM (
    SELECT "taskId", "personId"
    FROM "TaskMember"
    WHERE "removedAt" IS NULL
    GROUP BY "taskId", "personId"
    HAVING count(*) > 1
  ) duplicates;

  SELECT count(*) INTO zero_owner_count
  FROM "Task" task
  WHERE NOT EXISTS (
    SELECT 1 FROM "TaskMember" member
    WHERE member."taskId" = task.id
      AND member."removedAt" IS NULL
      AND member.role = 'OWNER'
  );

  SELECT count(*) INTO unowned_segment_count
  FROM "WorkSegment" segment
  WHERE segment."deletedAt" IS NULL
    AND segment."taskId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "TaskMember" member
      WHERE member."taskId" = segment."taskId"
        AND member."personId" = segment."personId"
        AND member."removedAt" IS NULL
    );

  SELECT count(*) INTO active_retired_role_count
  FROM "SystemRoleAssignment"
  WHERE "revokedAt" IS NULL
    AND role NOT IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR');

  IF invalid_role_count + duplicate_member_count + zero_owner_count
     + unowned_segment_count + active_retired_role_count > 0 THEN
    RAISE EXCEPTION
      'task access migration post-check failed invalid_roles=% duplicates=% zero_owners=% unowned_segments=% retired_roles=%',
      invalid_role_count, duplicate_member_count, zero_owner_count,
      unowned_segment_count, active_retired_role_count;
  END IF;
END $$;
