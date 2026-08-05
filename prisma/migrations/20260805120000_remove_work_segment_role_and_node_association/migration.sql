-- Work Segments now associate with Tasks only. Role and Task Node association
-- history is intentionally and irreversibly removed.

BEGIN;

-- This destructive cleanup is explicitly authorized. Temporarily suspend the
-- append-only guards and restore them before the transaction commits.
DROP TRIGGER "DomainAuditEvent_prevent_update" ON "DomainAuditEvent";
DROP TRIGGER "DomainAuditEvent_prevent_delete" ON "DomainAuditEvent";

-- Recipients are removed through the outbox foreign key's ON DELETE CASCADE.
DELETE FROM "NotificationOutbox"
WHERE "type" = 'segment_association_invalidated'
   OR "eventKey" LIKE 'pm:segment:association\_invalidated:%';

DELETE FROM "InAppNotification"
WHERE "eventKey" LIKE 'pm:segment:association\_invalidated:%'
   OR (
     jsonb_typeof("payload") = 'object'
     AND "payload" ->> 'kind' = 'segment_association_invalidated'
   );

-- Delete explicit relinks and the UPDATE history produced solely when a
-- Revision invalidated a Segment's former Node association.
DELETE FROM "WorkSegmentChange"
WHERE "action" = 'RELINK'
   OR (
     "action" = 'UPDATE'
     AND "reason" = 'Revision 生效后原关联节点失效'
     AND "before" -> 'associationNeedsReview' = 'false'::jsonb
     AND "after" -> 'associationNeedsReview' = 'true'::jsonb
   );

DELETE FROM "DomainAuditEvent"
WHERE "entityType" = 'WorkSegment'
  AND (
    "action" = 'pm.segment.relink'
    OR (
      "action" = 'pm.segment.update'
      AND "reason" = 'Revision 生效后原关联节点失效'
      AND "before" -> 'associationNeedsReview' = 'false'::jsonb
      AND "after" -> 'associationNeedsReview' = 'true'::jsonb
    )
  );

-- Retained records have no compatibility representation for removed fields.
UPDATE "WorkSegmentChange"
SET "before" = "before" - ARRAY[
  'role', 'customRole', 'nodeId', 'associationNeedsReview'
]::TEXT[]
WHERE jsonb_typeof("before") = 'object'
  AND "before" ?| ARRAY[
    'role', 'customRole', 'nodeId', 'associationNeedsReview'
  ];

UPDATE "WorkSegmentChange"
SET "after" = "after" - ARRAY[
  'role', 'customRole', 'nodeId', 'associationNeedsReview'
]::TEXT[]
WHERE jsonb_typeof("after") = 'object'
  AND "after" ?| ARRAY[
    'role', 'customRole', 'nodeId', 'associationNeedsReview'
  ];

UPDATE "DomainAuditEvent"
SET "before" = "before" - ARRAY[
  'role', 'customRole', 'nodeId', 'associationNeedsReview'
]::TEXT[]
WHERE jsonb_typeof("before") = 'object'
  AND "entityType" = 'WorkSegment'
  AND "before" ?| ARRAY[
    'role', 'customRole', 'nodeId', 'associationNeedsReview'
  ];

UPDATE "DomainAuditEvent"
SET "after" = "after" - ARRAY[
  'role', 'customRole', 'nodeId', 'associationNeedsReview'
]::TEXT[]
WHERE jsonb_typeof("after") = 'object'
  AND "entityType" = 'WorkSegment'
  AND "after" ?| ARRAY[
    'role', 'customRole', 'nodeId', 'associationNeedsReview'
  ];

ALTER TABLE "WorkSegmentChange"
  ALTER COLUMN "action" TYPE TEXT USING "action"::TEXT;

DROP TYPE "WorkSegmentChangeAction";

CREATE TYPE "WorkSegmentChangeAction" AS ENUM (
  'CREATE',
  'UPDATE',
  'SPLIT',
  'MERGE',
  'CONFIRM',
  'CANCEL',
  'DELETE'
);

ALTER TABLE "WorkSegmentChange"
  ALTER COLUMN "action" TYPE "WorkSegmentChangeAction"
  USING "action"::"WorkSegmentChangeAction";

DROP INDEX "WorkSegment_nodeId_type_idx";
DROP INDEX "WorkSegment_associationNeedsReview_personId_idx";

ALTER TABLE "WorkSegment"
  DROP CONSTRAINT "WorkSegment_nodeId_fkey",
  DROP CONSTRAINT "WorkSegment_custom_role_check",
  DROP CONSTRAINT "WorkSegment_node_requires_task_check",
  DROP COLUMN "role",
  DROP COLUMN "customRole",
  DROP COLUMN "nodeId",
  DROP COLUMN "associationNeedsReview";

DROP TYPE "WorkSegmentRole";

CREATE TRIGGER "DomainAuditEvent_prevent_update"
  BEFORE UPDATE ON "DomainAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_domain_audit_event_mutation"();

CREATE TRIGGER "DomainAuditEvent_prevent_delete"
  BEFORE DELETE ON "DomainAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_domain_audit_event_mutation"();

COMMIT;
