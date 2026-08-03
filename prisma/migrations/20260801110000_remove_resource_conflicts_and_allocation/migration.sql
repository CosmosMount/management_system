-- Resource conflicts and allocation percentages are intentionally removed.
-- This migration is destructive and relies on the deployment backup for recovery.

BEGIN;

-- The requested cleanup intentionally mutates a narrowly scoped subset of the
-- append-only audit table. Restore both guards before committing.
DROP TRIGGER "DomainAuditEvent_prevent_update" ON "DomainAuditEvent";
DROP TRIGGER "DomainAuditEvent_prevent_delete" ON "DomainAuditEvent";

DELETE FROM "NotificationPreference"
WHERE "category" = 'RESOURCE_CONFLICT';

DELETE FROM "InAppNotification"
WHERE "category" = 'RESOURCE_CONFLICT';

DELETE FROM "NotificationOutbox"
WHERE "type" IN ('resource_conflict_opened', 'resource_conflict_resolved');

DELETE FROM "DomainAuditEvent"
WHERE "entityType" = 'ResourceConflict';

UPDATE "WorkSegmentChange"
SET "before" = "before" - 'allocation'
WHERE jsonb_typeof("before") = 'object'
  AND "before" ? 'allocation';

UPDATE "WorkSegmentChange"
SET "after" = "after" - 'allocation'
WHERE jsonb_typeof("after") = 'object'
  AND "after" ? 'allocation';

UPDATE "DomainAuditEvent"
SET "before" = "before" - 'allocation'
WHERE jsonb_typeof("before") = 'object'
  AND "before" ? 'allocation';

UPDATE "DomainAuditEvent"
SET "after" = "after" - 'allocation'
WHERE jsonb_typeof("after") = 'object'
  AND "after" ? 'allocation';

ALTER TABLE "NotificationPreference"
  ALTER COLUMN "category" TYPE TEXT USING "category"::TEXT;

ALTER TABLE "InAppNotification"
  ALTER COLUMN "category" TYPE TEXT USING "category"::TEXT;

DROP TYPE "ProjectManagementNotificationCategory";

CREATE TYPE "ProjectManagementNotificationCategory" AS ENUM (
  'TASK',
  'MILESTONE',
  'REVIEW',
  'REVISION',
  'WORK_SEGMENT',
  'ACCOUNT_SECURITY'
);

ALTER TABLE "NotificationPreference"
  ALTER COLUMN "category" TYPE "ProjectManagementNotificationCategory"
  USING "category"::"ProjectManagementNotificationCategory";

ALTER TABLE "InAppNotification"
  ALTER COLUMN "category" TYPE "ProjectManagementNotificationCategory"
  USING "category"::"ProjectManagementNotificationCategory";

DROP TABLE "ConflictSegment";
DROP TABLE "ResourceConflict";
DROP TABLE "ProjectManagementScanCheckpoint";

ALTER TABLE "WorkSegment"
  DROP CONSTRAINT "WorkSegment_allocation_range_check",
  DROP COLUMN "allocation";

DROP TYPE "ResourceConflictKind";
DROP TYPE "ResourceConflictSeverity";
DROP TYPE "ResourceConflictStatus";

CREATE TRIGGER "DomainAuditEvent_prevent_update"
  BEFORE UPDATE ON "DomainAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_domain_audit_event_mutation"();

CREATE TRIGGER "DomainAuditEvent_prevent_delete"
  BEFORE DELETE ON "DomainAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_domain_audit_event_mutation"();

COMMIT;
