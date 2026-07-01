ALTER TABLE "NotificationOutbox"
  ADD COLUMN "botKind" TEXT NOT NULL DEFAULT 'notification';

UPDATE "NotificationOutbox"
SET "botKind" = 'approval'
WHERE "channel" = 'progress'
  AND "type" IN (
    'project_establishment_requested',
    'stage_pending_acceptance',
    'project_stage_extension_requested',
    'project_stage_batch_due_change_requested',
    'project_stage_due_change_requested',
    'task_ddl_change_requested',
    'task_delete_requested',
    'task_creation_requested',
    'task_bulk_creation_requested',
    'task_pending_acceptance'
  );

UPDATE "NotificationOutbox"
SET "botKind" = 'approval'
WHERE "channel" = 'procurement'
  AND "type" = 'order'
  AND ("payload"::jsonb #>> '{order,status}') IN (
    'MANAGEMENT_REVIEW',
    'TEACHER_REVIEW',
    'PENDING_FINANCE_REVIEW',
    'PENDING_APPLICANT_CONFIRM'
  );
