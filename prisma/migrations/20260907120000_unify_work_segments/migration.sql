BEGIN;

LOCK TABLE "WorkSegment", "WorkSegmentSource", "WorkSegmentChange"
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "WorkSegment" RENAME TO "LegacyWorkSegment";
ALTER TABLE "WorkSegmentSource" RENAME TO "LegacyWorkSegmentSource";
ALTER TABLE "WorkSegmentChange" RENAME TO "LegacyWorkSegmentChange";
ALTER TYPE "WorkSegmentType" RENAME TO "LegacyWorkSegmentType";
ALTER TYPE "WorkSegmentStatus" RENAME TO "LegacyWorkSegmentStatus";
ALTER TYPE "WorkSegmentChangeAction" RENAME TO "LegacyWorkSegmentChangeAction";

DO $$
DECLARE
  archived_index RECORD;
  external_reference RECORD;
BEGIN
  FOR archived_index IN
    SELECT index_class.relname, namespace.nspname
    FROM pg_index index_definition
    JOIN pg_class index_class ON index_class.oid = index_definition.indexrelid
    JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
    WHERE index_definition.indrelid IN (
      '"LegacyWorkSegment"'::regclass,
      '"LegacyWorkSegmentSource"'::regclass,
      '"LegacyWorkSegmentChange"'::regclass
    )
  LOOP
    EXECUTE format('ALTER INDEX %I.%I RENAME TO %I',
      archived_index.nspname, archived_index.relname,
      'Legacy_' || left(archived_index.relname, 46) || '_' || left(md5(archived_index.relname), 8));
  END LOOP;

  FOR external_reference IN
    SELECT conrelid::regclass AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid IN (
        '"LegacyWorkSegment"'::regclass,
        '"LegacyWorkSegmentSource"'::regclass,
        '"LegacyWorkSegmentChange"'::regclass
      )
      AND confrelid NOT IN (
        '"LegacyWorkSegment"'::regclass,
        '"LegacyWorkSegmentSource"'::regclass,
        '"LegacyWorkSegmentChange"'::regclass
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',
      external_reference.table_name, external_reference.conname);
  END LOOP;
END $$;

CREATE TYPE "WorkSegmentChangeAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

CREATE TABLE "WorkSegment" (
  "id" TEXT NOT NULL,
  "personId" TEXT NOT NULL,
  "startAt" TIMESTAMPTZ(6) NOT NULL,
  "endAt" TIMESTAMPTZ(6) NOT NULL,
  "content" TEXT NOT NULL,
  "taskId" TEXT,
  "createdByAccountId" TEXT NOT NULL,
  "updatedByAccountId" TEXT,
  "deletedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "WorkSegment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkSegment_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WorkSegment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "WorkSegment_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WorkSegment_updatedByAccountId_fkey" FOREIGN KEY ("updatedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "WorkSegment_time_order_check" CHECK ("endAt" > "startAt"),
  CONSTRAINT "WorkSegment_content_not_blank_check" CHECK (length(btrim("content")) > 0)
);

CREATE INDEX "WorkSegment_personId_startAt_endAt_idx" ON "WorkSegment"("personId", "startAt", "endAt");
CREATE INDEX "WorkSegment_taskId_startAt_idx" ON "WorkSegment"("taskId", "startAt");
CREATE INDEX "WorkSegment_createdByAccountId_idx" ON "WorkSegment"("createdByAccountId");
CREATE INDEX "WorkSegment_updatedByAccountId_idx" ON "WorkSegment"("updatedByAccountId");
CREATE INDEX "WorkSegment_deletedAt_idx" ON "WorkSegment"("deletedAt");
CREATE INDEX "WorkSegment_updatedAt_id_idx" ON "WorkSegment"("updatedAt", "id");

CREATE TABLE "WorkSegmentChange" (
  "id" TEXT NOT NULL,
  "segmentId" TEXT NOT NULL,
  "action" "WorkSegmentChangeAction" NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "reason" TEXT NOT NULL DEFAULT '',
  "actorAccountId" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkSegmentChange_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkSegmentChange_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "WorkSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "WorkSegmentChange_actorAccountId_fkey" FOREIGN KEY ("actorAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "WorkSegmentChange_segmentId_createdAt_idx" ON "WorkSegmentChange"("segmentId", "createdAt");
CREATE INDEX "WorkSegmentChange_actorAccountId_idx" ON "WorkSegmentChange"("actorAccountId");

INSERT INTO "WorkSegment" (
  "id", "personId", "startAt", "endAt", "content", "taskId",
  "createdByAccountId", "updatedByAccountId", "deletedAt", "createdAt", "updatedAt"
)
SELECT "id", "personId", "startAt", "endAt", "content", "taskId",
  "createdByAccountId", "updatedByAccountId", "deletedAt", "createdAt", "updatedAt"
FROM "LegacyWorkSegment"
WHERE "deletedAt" IS NULL
  AND NOT ("type"::TEXT = 'PLANNED' AND "status"::TEXT IN ('CONFIRMED', 'CANCELLED'));

UPDATE "NotificationOutboxRecipient" recipient
SET "status" = 'CANCELED', "lockedUntil" = NULL,
  "lastError" = '投入确认功能已退役，不再投递', "updatedAt" = CURRENT_TIMESTAMP
FROM "NotificationOutbox" outbox
WHERE recipient."outboxId" = outbox."id"
  AND outbox."channel" = 'project-management'
  AND outbox."type" = 'segment_confirmation_due'
  AND recipient."status" IN ('PENDING', 'PROCESSING', 'FAILED');

UPDATE "NotificationOutbox"
SET "status" = 'CANCELED', "lockedUntil" = NULL,
  "lastError" = '投入确认功能已退役，不再投递', "updatedAt" = CURRENT_TIMESTAMP
WHERE "channel" = 'project-management' AND "type" = 'segment_confirmation_due'
  AND "status" IN ('PENDING', 'PROCESSING', 'FAILED');

UPDATE "InAppNotification"
SET "readAt" = CURRENT_TIMESTAMP
WHERE "readAt" IS NULL AND "category" = 'WORK_SEGMENT'
  AND ("payload" ->> 'kind' = 'segment_confirmation_due'
    OR "eventKey" LIKE 'pm:segment:confirmation\_due:%');

INSERT INTO "DomainAuditEvent" (
  "id", "action", "entityType", "entityId", "before", "after",
  "reason", "requestId", "source", "schemaVersion", "createdAt"
)
VALUES (
  'migration:unify-work-segments:v1', 'pm.segment.migrated', 'WorkSegment',
  'migration:unify-work-segments:v1',
  jsonb_build_object(
    'segments', (SELECT count(*) FROM "LegacyWorkSegment"),
    'sources', (SELECT count(*) FROM "LegacyWorkSegmentSource"),
    'changes', (SELECT count(*) FROM "LegacyWorkSegmentChange")
  ),
  jsonb_build_object('segments', (SELECT count(*) FROM "WorkSegment"), 'legacyArchived', true),
  '投入统一为时间记录；保留完整旧数据和审计，停止投入确认提醒', '', 'MIGRATION', 1, CURRENT_TIMESTAMP
);

CREATE FUNCTION prevent_legacy_work_segment_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Legacy work segment archives are read-only';
END $$;

CREATE TRIGGER "LegacyWorkSegment_read_only"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "LegacyWorkSegment"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_legacy_work_segment_mutation();
CREATE TRIGGER "LegacyWorkSegmentSource_read_only"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "LegacyWorkSegmentSource"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_legacy_work_segment_mutation();
CREATE TRIGGER "LegacyWorkSegmentChange_read_only"
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "LegacyWorkSegmentChange"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_legacy_work_segment_mutation();

DO $$
BEGIN
  IF EXISTS (
    (SELECT "id", "personId", "startAt", "endAt", "content", "taskId", "createdByAccountId", "updatedByAccountId", "deletedAt", "createdAt", "updatedAt"
     FROM "LegacyWorkSegment" WHERE "deletedAt" IS NULL
       AND NOT ("type"::TEXT = 'PLANNED' AND "status"::TEXT IN ('CONFIRMED', 'CANCELLED'))
     EXCEPT SELECT * FROM "WorkSegment")
    UNION ALL
    (SELECT * FROM "WorkSegment"
     EXCEPT SELECT "id", "personId", "startAt", "endAt", "content", "taskId", "createdByAccountId", "updatedByAccountId", "deletedAt", "createdAt", "updatedAt"
     FROM "LegacyWorkSegment" WHERE "deletedAt" IS NULL
       AND NOT ("type"::TEXT = 'PLANNED' AND "status"::TEXT IN ('CONFIRMED', 'CANCELLED')))
  ) THEN
    RAISE EXCEPTION 'Unified work segment migration did not preserve the visible records';
  END IF;
END $$;

COMMIT;
