-- Prepare drifted databases for the historical, non-idempotent Work Segment
-- removal migration. Some environments recorded the P1 schema migration while
-- later restoring the task-only WorkSegment shape outside Prisma Migrate.
--
-- This migration intentionally sorts before
-- 20260805120000_remove_work_segment_role_and_node_association. When an
-- environment has already applied that removal migration, Prisma may discover
-- this newly added earlier migration later; in that case it must remain a
-- no-op so removed columns are not recreated after final convergence.

BEGIN;

DO $prepare_removal$
DECLARE
  schema_name TEXT := current_schema();
  migration_history REGCLASS;
  removal_already_applied BOOLEAN := false;
  actual_role_values TEXT[];
  expected_role_values CONSTANT TEXT[] := ARRAY[
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
  migration_history := to_regclass(
    format('%I.%I', schema_name, '_prisma_migrations')
  );

  IF migration_history IS NOT NULL THEN
    EXECUTE format(
      'SELECT EXISTS (
         SELECT 1
         FROM %s
         WHERE migration_name = $1
           AND finished_at IS NOT NULL
           AND rolled_back_at IS NULL
       )',
      migration_history
    )
    INTO removal_already_applied
    USING '20260805120000_remove_work_segment_role_and_node_association';
  END IF;

  IF removal_already_applied THEN
    RETURN;
  END IF;

  IF to_regtype(format('%I.%I', schema_name, 'WorkSegmentRole')) IS NULL THEN
    EXECUTE format(
      'CREATE TYPE %I.%I AS ENUM (
         ''OWNER'',
         ''LEAD'',
         ''DEVELOPER'',
         ''DESIGNER'',
         ''REVIEWER'',
         ''SUPPORT'',
         ''OBSERVER'',
         ''CUSTOM''
       )',
      schema_name,
      'WorkSegmentRole'
    );
  ELSE
    SELECT array_agg(enum.enumlabel::TEXT ORDER BY enum.enumsortorder)
    INTO actual_role_values
    FROM pg_enum enum
    JOIN pg_type type ON type.oid = enum.enumtypid
    JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = schema_name
      AND type.typname = 'WorkSegmentRole';

    IF actual_role_values IS DISTINCT FROM expected_role_values THEN
      RAISE EXCEPTION
        'WorkSegmentRole exists with unexpected values before removal: %',
        actual_role_values;
    END IF;
  END IF;

  IF to_regtype(
    format('%I.%I', schema_name, 'WorkSegmentChangeAction')
  ) IS NULL THEN
    RAISE EXCEPTION
      'WorkSegmentChangeAction is missing before Work Segment removal';
  END IF;

  EXECUTE format(
    'ALTER TYPE %I.%I ADD VALUE IF NOT EXISTS ''RELINK''',
    schema_name,
    'WorkSegmentChangeAction'
  );

  EXECUTE format(
    'ALTER TABLE %I.%I
       ADD COLUMN IF NOT EXISTS "role" %I.%I NOT NULL DEFAULT ''DEVELOPER''',
    schema_name,
    'WorkSegment',
    schema_name,
    'WorkSegmentRole'
  );
  EXECUTE format(
    'ALTER TABLE %I.%I
       ADD COLUMN IF NOT EXISTS "customRole" TEXT',
    schema_name,
    'WorkSegment'
  );
  EXECUTE format(
    'ALTER TABLE %I.%I
       ADD COLUMN IF NOT EXISTS "nodeId" TEXT',
    schema_name,
    'WorkSegment'
  );
  EXECUTE format(
    'ALTER TABLE %I.%I
       ADD COLUMN IF NOT EXISTS "associationNeedsReview" BOOLEAN NOT NULL DEFAULT false',
    schema_name,
    'WorkSegment'
  );

  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I
       ON %I.%I ("nodeId", "type")',
    'WorkSegment_nodeId_type_idx',
    schema_name,
    'WorkSegment'
  );
  EXECUTE format(
    'CREATE INDEX IF NOT EXISTS %I
       ON %I.%I ("associationNeedsReview", "personId")',
    'WorkSegment_associationNeedsReview_personId_idx',
    schema_name,
    'WorkSegment'
  );

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = format('%I.%I', schema_name, 'WorkSegment')::regclass
      AND conname = 'WorkSegment_nodeId_fkey'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I
         ADD CONSTRAINT %I
         FOREIGN KEY ("nodeId") REFERENCES %I.%I ("id")
         ON DELETE SET NULL ON UPDATE CASCADE',
      schema_name,
      'WorkSegment',
      'WorkSegment_nodeId_fkey',
      schema_name,
      'TaskNode'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = format('%I.%I', schema_name, 'WorkSegment')::regclass
      AND conname = 'WorkSegment_custom_role_check'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I
         ADD CONSTRAINT %I
         CHECK (
           "role" <> ''CUSTOM''
           OR length(btrim(coalesce("customRole", ''''))) > 0
         )',
      schema_name,
      'WorkSegment',
      'WorkSegment_custom_role_check'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = format('%I.%I', schema_name, 'WorkSegment')::regclass
      AND conname = 'WorkSegment_node_requires_task_check'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I.%I
         ADD CONSTRAINT %I
         CHECK ("nodeId" IS NULL OR "taskId" IS NOT NULL)',
      schema_name,
      'WorkSegment',
      'WorkSegment_node_requires_task_check'
    );
  END IF;
END
$prepare_removal$;

COMMIT;
