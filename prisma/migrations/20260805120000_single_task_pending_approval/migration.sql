-- Withdraw every currently pending Task approval before the application starts
-- enforcing one pending approval per Task. Run with application writes and the
-- notification worker stopped so an old process cannot create a new request
-- after this migration commits.
BEGIN;

CREATE TEMP TABLE "_WithdrawnMilestoneApprovals" ON COMMIT DROP AS
SELECT
  review.id,
  node."taskId",
  review."milestoneNodeId",
  review."submittedByAccountId",
  review."createdAt"
FROM "MilestoneReview" review
JOIN "MilestoneNode" milestone ON milestone.id = review."milestoneNodeId"
JOIN "TaskNode" node ON node.id = milestone."nodeId"
WHERE review.result = 'PENDING'
  AND review."revokedAt" IS NULL;

CREATE TEMP TABLE "_WithdrawnRevisionApprovals" ON COMMIT DROP AS
SELECT
  revision.id,
  node."taskId",
  revision."nodeId",
  revision."reviewRound",
  target.id AS "targetPlanVersionId"
FROM "RevisionNode" revision
JOIN "TaskNode" node ON node.id = revision."nodeId"
LEFT JOIN "TaskPlanVersion" target ON target."revisionNodeId" = revision.id
WHERE revision.status = 'PENDING_APPROVAL';

UPDATE "MilestoneReview" review
SET
  "revokedAt" = CURRENT_TIMESTAMP,
  "revokedByAccountId" = NULL,
  "revokeReason" = '单一审批门禁上线：当前 Task 待审批已统一撤出'
FROM "_WithdrawnMilestoneApprovals" withdrawn
WHERE review.id = withdrawn.id;

UPDATE "TaskNode" node
SET status = 'CANCELLED'
WHERE node.status IN ('PENDING', 'ACTIVE')
  AND EXISTS (
    SELECT 1
    FROM "PlanVersionNode" entry
    JOIN "_WithdrawnRevisionApprovals" withdrawn
      ON withdrawn."targetPlanVersionId" = entry."planVersionId"
    WHERE entry."nodeId" = node.id
      AND entry."isCarryForward" = false
  );

UPDATE "TaskPlanVersion" plan
SET status = 'ABANDONED'
FROM "_WithdrawnRevisionApprovals" withdrawn
WHERE plan.id = withdrawn."targetPlanVersionId"
  AND plan.status = 'DRAFT';

UPDATE "RevisionNode" revision
SET
  status = 'CANCELLED',
  "reviewedAt" = CURRENT_TIMESTAMP,
  "reviewedByAccountId" = NULL,
  "reviewComment" = '单一审批门禁上线：当前 Task 待审批已统一撤出'
FROM "_WithdrawnRevisionApprovals" withdrawn
WHERE revision.id = withdrawn.id;

INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", "taskId", before, after,
  reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:single-task-approval:v1:MilestoneReview:' || withdrawn.id,
  'pm.milestone.review.withdraw',
  'MilestoneReview',
  withdrawn.id,
  withdrawn."taskId",
  jsonb_build_object(
    'result', 'PENDING',
    'revokedAt', NULL,
    'milestoneNodeId', withdrawn."milestoneNodeId"
  ),
  jsonb_build_object(
    'result', 'PENDING',
    'revokedAt', CURRENT_TIMESTAMP,
    'revokedByAccountId', NULL
  ),
  '单一审批门禁上线：当前 Task 待审批已统一撤出；不发送用户通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "_WithdrawnMilestoneApprovals" withdrawn
ON CONFLICT (id) DO NOTHING;

INSERT INTO "DomainAuditEvent" (
  id, action, "entityType", "entityId", "taskId", before, after,
  reason, "requestId", source, "schemaVersion", "createdAt"
)
SELECT
  'migration:single-task-approval:v1:RevisionNode:' || withdrawn.id,
  'pm.revision.withdraw',
  'RevisionNode',
  withdrawn.id,
  withdrawn."taskId",
  jsonb_build_object(
    'status', 'PENDING_APPROVAL',
    'reviewRound', withdrawn."reviewRound",
    'targetPlanVersionId', withdrawn."targetPlanVersionId",
    'targetPlanVersionStatus', 'DRAFT'
  ),
  jsonb_build_object(
    'status', 'CANCELLED',
    'reviewRound', withdrawn."reviewRound",
    'targetPlanVersionId', withdrawn."targetPlanVersionId",
    'targetPlanVersionStatus', 'ABANDONED'
  ),
  '单一审批门禁上线：当前 Task 待审批已统一撤出；不发送用户通知',
  '',
  'MIGRATION',
  1,
  CURRENT_TIMESTAMP
FROM "_WithdrawnRevisionApprovals" withdrawn
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE "_WithdrawnTaskApprovalOutboxes" ON COMMIT DROP AS
SELECT outbox.id
FROM "NotificationOutbox" outbox
WHERE outbox.channel = 'project-management'
  AND outbox.status IN ('PENDING', 'PROCESSING', 'FAILED')
  AND (
    (
      outbox.type = 'milestone_review_submitted'
      AND EXISTS (
        SELECT 1
        FROM "_WithdrawnMilestoneApprovals" withdrawn
        WHERE outbox.payload::jsonb ->> 'entityId' = withdrawn.id
      )
    )
    OR
    (
      outbox.type = 'revision_pending_review'
      AND EXISTS (
        SELECT 1
        FROM "_WithdrawnRevisionApprovals" withdrawn
        WHERE outbox.payload::jsonb ->> 'entityId' = withdrawn.id
      )
    )
  );

UPDATE "NotificationOutboxRecipient" recipient
SET
  status = 'FAILED',
  attempts = GREATEST(recipient.attempts, 8),
  "lastError" = 'Task 待审批已由单一审批门禁迁移撤出；投递永久冻结',
  "nextRunAt" = TIMESTAMPTZ '9999-12-31 00:00:00+00',
  "lockedUntil" = NULL
FROM "_WithdrawnTaskApprovalOutboxes" withdrawn
WHERE recipient."outboxId" = withdrawn.id
  AND recipient.status IN ('PENDING', 'PROCESSING', 'FAILED');

UPDATE "NotificationOutbox" outbox
SET
  status = 'FAILED',
  attempts = GREATEST(outbox.attempts, 8),
  "lastError" = 'Task 待审批已由单一审批门禁迁移撤出；投递永久冻结',
  "nextRunAt" = TIMESTAMPTZ '9999-12-31 00:00:00+00',
  "lockedUntil" = NULL
FROM "_WithdrawnTaskApprovalOutboxes" withdrawn
WHERE outbox.id = withdrawn.id;

UPDATE "InAppNotification" notification
SET "readAt" = CURRENT_TIMESTAMP
WHERE notification."readAt" IS NULL
  AND (
    (
      notification."entityType" = 'MilestoneReview'
      AND notification.payload ->> 'kind' = 'milestone_review_submitted'
      AND EXISTS (
        SELECT 1
        FROM "_WithdrawnMilestoneApprovals" withdrawn
        WHERE notification."entityId" = withdrawn.id
      )
    )
    OR
    (
      notification."entityType" = 'RevisionNode'
      AND notification.payload ->> 'kind' = 'revision_pending_review'
      AND EXISTS (
        SELECT 1
        FROM "_WithdrawnRevisionApprovals" withdrawn
        WHERE notification."entityId" = withdrawn.id
      )
    )
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MilestoneReview"
    WHERE result = 'PENDING' AND "revokedAt" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM "RevisionNode"
    WHERE status = 'PENDING_APPROVAL'
  ) THEN
    RAISE EXCEPTION
      'single Task approval migration failed: pending Task approvals remain after withdrawal';
  END IF;
END $$;

COMMIT;
