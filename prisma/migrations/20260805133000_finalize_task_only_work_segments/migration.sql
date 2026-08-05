-- Work Segment 最终只关联 Task。
--
-- 该收敛迁移必须保留：部分环境已经执行过 20260805130000 至
-- 20260805132000 的结构漂移修复，而另一些环境会先执行同时间戳的旧删除
-- migration。所有路径最终都必须得到相同的 task-only schema。

BEGIN;

-- 关联失效历史按已接受的不可兼容方案永久删除。临时撤下 append-only
-- trigger，事务提交前恢复；任一步失败都会随事务整体回滚。
DROP TRIGGER IF EXISTS "DomainAuditEvent_prevent_update" ON "DomainAuditEvent";
DROP TRIGGER IF EXISTS "DomainAuditEvent_prevent_delete" ON "DomainAuditEvent";

DELETE FROM "NotificationOutbox"
WHERE "type" = 'segment_association_invalidated'
   OR "eventKey" LIKE 'pm:segment:association\_invalidated:%';

DELETE FROM "InAppNotification"
WHERE "eventKey" LIKE 'pm:segment:association\_invalidated:%'
   OR (
     jsonb_typeof("payload") = 'object'
     AND "payload" ->> 'kind' = 'segment_association_invalidated'
   );

DELETE FROM "WorkSegmentChange"
WHERE "action"::TEXT = 'RELINK'
   OR (
     "action"::TEXT = 'UPDATE'
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

-- 无论当前 enum 是否仍含 RELINK，都重建为最终集合。
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

DROP INDEX IF EXISTS "WorkSegment_nodeId_type_idx";
DROP INDEX IF EXISTS "WorkSegment_associationNeedsReview_personId_idx";

ALTER TABLE "WorkSegment"
  DROP CONSTRAINT IF EXISTS "WorkSegment_nodeId_fkey",
  DROP CONSTRAINT IF EXISTS "WorkSegment_custom_role_check",
  DROP CONSTRAINT IF EXISTS "WorkSegment_node_requires_task_check",
  DROP COLUMN IF EXISTS "role",
  DROP COLUMN IF EXISTS "customRole",
  DROP COLUMN IF EXISTS "nodeId",
  DROP COLUMN IF EXISTS "associationNeedsReview";

DROP TYPE IF EXISTS "WorkSegmentRole";

CREATE TRIGGER "DomainAuditEvent_prevent_update"
  BEFORE UPDATE ON "DomainAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_domain_audit_event_mutation"();

CREATE TRIGGER "DomainAuditEvent_prevent_delete"
  BEFORE DELETE ON "DomainAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_domain_audit_event_mutation"();

DO $$
DECLARE
  remaining_columns INTEGER;
  action_values TEXT[];
  audit_trigger_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO remaining_columns
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'WorkSegment'
    AND column_name IN (
      'role', 'customRole', 'nodeId', 'associationNeedsReview'
    );

  IF remaining_columns <> 0 THEN
    RAISE EXCEPTION 'WorkSegment task-only 收敛失败：仍存在 % 个废弃字段', remaining_columns;
  END IF;

  IF to_regtype(format('%I.%I', current_schema(), 'WorkSegmentRole')) IS NOT NULL THEN
    RAISE EXCEPTION 'WorkSegment task-only 收敛失败：WorkSegmentRole 仍存在';
  END IF;

  SELECT array_agg(enumlabel ORDER BY enumsortorder)
  INTO action_values
  FROM pg_enum
  WHERE enumtypid = to_regtype(
    format('%I.%I', current_schema(), 'WorkSegmentChangeAction')
  );

  IF action_values IS DISTINCT FROM ARRAY[
    'CREATE', 'UPDATE', 'SPLIT', 'MERGE', 'CONFIRM', 'CANCEL', 'DELETE'
  ]::TEXT[] THEN
    RAISE EXCEPTION 'WorkSegmentChangeAction 最终枚举不正确：%', action_values;
  END IF;

  SELECT COUNT(*)
  INTO audit_trigger_count
  FROM pg_trigger
  WHERE tgrelid = format('%I.%I', current_schema(), 'DomainAuditEvent')::regclass
    AND tgname IN (
      'DomainAuditEvent_prevent_update',
      'DomainAuditEvent_prevent_delete'
    )
    AND NOT tgisinternal;

  IF audit_trigger_count <> 2 THEN
    RAISE EXCEPTION 'DomainAuditEvent append-only trigger 未完整恢复';
  END IF;
END
$$;

COMMIT;
