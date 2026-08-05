-- Repair databases whose Prisma migration history records the P1 project
-- management migration as applied while the legacy WorkSegment shape was
-- restored later outside Prisma Migrate. The statements are intentionally
-- additive and are no-ops for databases that already match the schema.

BEGIN;

DO $$
DECLARE
  actual_values TEXT[];
  expected_values CONSTANT TEXT[] := ARRAY[
    'OWNER',
    'LEAD',
    'DEVELOPER',
    'DESIGNER',
    'REVIEWER',
    'SUPPORT',
    'OBSERVER',
    'CUSTOM'
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type type
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = current_schema()
      AND type.typname = 'WorkSegmentRole'
  ) THEN
    CREATE TYPE "WorkSegmentRole" AS ENUM (
      'OWNER',
      'LEAD',
      'DEVELOPER',
      'DESIGNER',
      'REVIEWER',
      'SUPPORT',
      'OBSERVER',
      'CUSTOM'
    );
  ELSE
    SELECT array_agg(enum.enumlabel::TEXT ORDER BY enum.enumsortorder)
    INTO actual_values
    FROM pg_enum enum
    JOIN pg_type type ON type.oid = enum.enumtypid
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = current_schema()
      AND type.typname = 'WorkSegmentRole';

    IF actual_values IS DISTINCT FROM expected_values THEN
      RAISE EXCEPTION
        'WorkSegmentRole exists with unexpected values: %',
        actual_values;
    END IF;
  END IF;
END $$;

ALTER TYPE "WorkSegmentChangeAction" ADD VALUE IF NOT EXISTS 'RELINK';

ALTER TABLE "WorkSegment"
  ADD COLUMN IF NOT EXISTS "role" "WorkSegmentRole" NOT NULL DEFAULT 'DEVELOPER',
  ADD COLUMN IF NOT EXISTS "customRole" TEXT,
  ADD COLUMN IF NOT EXISTS "nodeId" TEXT,
  ADD COLUMN IF NOT EXISTS "associationNeedsReview" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "WorkSegment_nodeId_type_idx"
  ON "WorkSegment"("nodeId", "type");

CREATE INDEX IF NOT EXISTS "WorkSegment_associationNeedsReview_personId_idx"
  ON "WorkSegment"("associationNeedsReview", "personId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"WorkSegment"'::regclass
      AND conname = 'WorkSegment_nodeId_fkey'
  ) THEN
    ALTER TABLE "WorkSegment"
      ADD CONSTRAINT "WorkSegment_nodeId_fkey"
      FOREIGN KEY ("nodeId") REFERENCES "TaskNode"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"WorkSegment"'::regclass
      AND conname = 'WorkSegment_custom_role_check'
  ) THEN
    ALTER TABLE "WorkSegment"
      ADD CONSTRAINT "WorkSegment_custom_role_check"
      CHECK (
        "role" <> 'CUSTOM'
        OR length(btrim(coalesce("customRole", ''))) > 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = '"WorkSegment"'::regclass
      AND conname = 'WorkSegment_node_requires_task_check'
  ) THEN
    ALTER TABLE "WorkSegment"
      ADD CONSTRAINT "WorkSegment_node_requires_task_check"
      CHECK ("nodeId" IS NULL OR "taskId" IS NOT NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'WorkSegment'
      AND column_name = 'associationNeedsReview'
      AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'WorkSegment'
      AND column_name = 'nodeId'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_enum enum
    JOIN pg_type type ON type.oid = enum.enumtypid
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = current_schema()
      AND type.typname = 'WorkSegmentChangeAction'
      AND enum.enumlabel = 'RELINK'
  ) THEN
    RAISE EXCEPTION 'WorkSegment schema drift repair did not reach its postcondition';
  END IF;
END $$;

COMMIT;
