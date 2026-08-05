-- Validate the complete catalog shape after the additive WorkSegment repair.
-- If a same-named object already existed with a different definition, fail
-- closed instead of recording a successful migration over unresolved drift.

BEGIN;

DO $$
DECLARE
  actual_role_values TEXT[];
  actual_action_values TEXT[];
BEGIN
  SELECT array_agg(enum.enumlabel::TEXT ORDER BY enum.enumsortorder)
  INTO actual_role_values
  FROM pg_enum enum
  JOIN pg_type type ON type.oid = enum.enumtypid
  JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
  WHERE namespace.nspname = current_schema()
    AND type.typname = 'WorkSegmentRole';

  IF actual_role_values IS DISTINCT FROM ARRAY[
    'OWNER',
    'LEAD',
    'DEVELOPER',
    'DESIGNER',
    'REVIEWER',
    'SUPPORT',
    'OBSERVER',
    'CUSTOM'
  ]::TEXT[] THEN
    RAISE EXCEPTION
      'WorkSegmentRole has unexpected values: %',
      actual_role_values;
  END IF;

  SELECT array_agg(enum.enumlabel::TEXT ORDER BY enum.enumsortorder)
  INTO actual_action_values
  FROM pg_enum enum
  JOIN pg_type type ON type.oid = enum.enumtypid
  JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
  WHERE namespace.nspname = current_schema()
    AND type.typname = 'WorkSegmentChangeAction';

  IF actual_action_values IS DISTINCT FROM ARRAY[
    'CREATE',
    'UPDATE',
    'SPLIT',
    'MERGE',
    'CONFIRM',
    'CANCEL',
    'DELETE',
    'RELINK'
  ]::TEXT[] THEN
    RAISE EXCEPTION
      'WorkSegmentChangeAction has unexpected values: %',
      actual_action_values;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute attribute
    JOIN pg_class table_record ON table_record.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = table_record.relnamespace
    LEFT JOIN pg_attrdef default_record
      ON default_record.adrelid = attribute.attrelid
      AND default_record.adnum = attribute.attnum
    WHERE namespace.nspname = current_schema()
      AND table_record.relname = 'WorkSegment'
      AND attribute.attname = 'role'
      AND NOT attribute.attisdropped
      AND attribute.atttypid = '"WorkSegmentRole"'::regtype
      AND attribute.attnotnull
      AND pg_get_expr(
        default_record.adbin,
        default_record.adrelid,
        true
      ) = '''DEVELOPER''::"WorkSegmentRole"'
  ) THEN
    RAISE EXCEPTION 'WorkSegment.role has an unexpected definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute attribute
    JOIN pg_class table_record ON table_record.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = table_record.relnamespace
    LEFT JOIN pg_attrdef default_record
      ON default_record.adrelid = attribute.attrelid
      AND default_record.adnum = attribute.attnum
    WHERE namespace.nspname = current_schema()
      AND table_record.relname = 'WorkSegment'
      AND attribute.attname = 'customRole'
      AND NOT attribute.attisdropped
      AND attribute.atttypid = 'text'::regtype
      AND NOT attribute.attnotnull
      AND default_record.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'WorkSegment.customRole has an unexpected definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute attribute
    JOIN pg_class table_record ON table_record.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = table_record.relnamespace
    LEFT JOIN pg_attrdef default_record
      ON default_record.adrelid = attribute.attrelid
      AND default_record.adnum = attribute.attnum
    WHERE namespace.nspname = current_schema()
      AND table_record.relname = 'WorkSegment'
      AND attribute.attname = 'nodeId'
      AND NOT attribute.attisdropped
      AND attribute.atttypid = 'text'::regtype
      AND NOT attribute.attnotnull
      AND default_record.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'WorkSegment.nodeId has an unexpected definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute attribute
    JOIN pg_class table_record ON table_record.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = table_record.relnamespace
    LEFT JOIN pg_attrdef default_record
      ON default_record.adrelid = attribute.attrelid
      AND default_record.adnum = attribute.attnum
    WHERE namespace.nspname = current_schema()
      AND table_record.relname = 'WorkSegment'
      AND attribute.attname = 'associationNeedsReview'
      AND NOT attribute.attisdropped
      AND attribute.atttypid = 'boolean'::regtype
      AND attribute.attnotnull
      AND pg_get_expr(
        default_record.adbin,
        default_record.adrelid,
        true
      ) = 'false'
  ) THEN
    RAISE EXCEPTION
      'WorkSegment.associationNeedsReview has an unexpected definition';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class index_record
    JOIN pg_namespace namespace ON namespace.oid = index_record.relnamespace
    JOIN pg_index index_metadata ON index_metadata.indexrelid = index_record.oid
    JOIN pg_class table_record ON table_record.oid = index_metadata.indrelid
    JOIN pg_am access_method ON access_method.oid = index_record.relam
    WHERE namespace.nspname = current_schema()
      AND table_record.relname = 'WorkSegment'
      AND index_record.relname = 'WorkSegment_nodeId_type_idx'
      AND access_method.amname = 'btree'
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indislive
      AND NOT index_metadata.indisunique
      AND NOT index_metadata.indisprimary
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnatts = 2
      AND index_metadata.indnkeyatts = 2
      AND (
        SELECT array_agg(attribute.attname ORDER BY key.ordinality)
        FROM unnest(index_metadata.indkey::SMALLINT[])
          WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = index_metadata.indrelid
          AND attribute.attnum = key.attnum
      ) = ARRAY['nodeId', 'type']::NAME[]
  ) THEN
    RAISE EXCEPTION
      'WorkSegment_nodeId_type_idx has an unexpected definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class index_record
    JOIN pg_namespace namespace ON namespace.oid = index_record.relnamespace
    JOIN pg_index index_metadata ON index_metadata.indexrelid = index_record.oid
    JOIN pg_class table_record ON table_record.oid = index_metadata.indrelid
    JOIN pg_am access_method ON access_method.oid = index_record.relam
    WHERE namespace.nspname = current_schema()
      AND table_record.relname = 'WorkSegment'
      AND index_record.relname =
        'WorkSegment_associationNeedsReview_personId_idx'
      AND access_method.amname = 'btree'
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indislive
      AND NOT index_metadata.indisunique
      AND NOT index_metadata.indisprimary
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnatts = 2
      AND index_metadata.indnkeyatts = 2
      AND (
        SELECT array_agg(attribute.attname ORDER BY key.ordinality)
        FROM unnest(index_metadata.indkey::SMALLINT[])
          WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute attribute
          ON attribute.attrelid = index_metadata.indrelid
          AND attribute.attnum = key.attnum
      ) = ARRAY['associationNeedsReview', 'personId']::NAME[]
  ) THEN
    RAISE EXCEPTION
      'WorkSegment_associationNeedsReview_personId_idx has an unexpected definition';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_record
    WHERE constraint_record.conrelid = '"WorkSegment"'::regclass
      AND constraint_record.conname = 'WorkSegment_nodeId_fkey'
      AND constraint_record.contype = 'f'
      AND constraint_record.confrelid = '"TaskNode"'::regclass
      AND constraint_record.conkey = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = '"WorkSegment"'::regclass
            AND attname = 'nodeId'
        )
      ]::SMALLINT[]
      AND constraint_record.confkey = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = '"TaskNode"'::regclass
            AND attname = 'id'
        )
      ]::SMALLINT[]
      AND constraint_record.confmatchtype = 's'
      AND constraint_record.confupdtype = 'c'
      AND constraint_record.confdeltype = 'n'
      AND constraint_record.convalidated
      AND NOT constraint_record.condeferrable
  ) THEN
    RAISE EXCEPTION 'WorkSegment_nodeId_fkey has an unexpected definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_record
    WHERE constraint_record.conrelid = '"WorkSegment"'::regclass
      AND constraint_record.conname = 'WorkSegment_custom_role_check'
      AND constraint_record.contype = 'c'
      AND constraint_record.convalidated
      AND NOT constraint_record.connoinherit
      AND pg_get_expr(
        constraint_record.conbin,
        constraint_record.conrelid,
        true
      ) = 'role <> ''CUSTOM''::"WorkSegmentRole" OR '
        || 'length(btrim(COALESCE("customRole", ''''::text))) > 0'
  ) THEN
    RAISE EXCEPTION
      'WorkSegment_custom_role_check has an unexpected definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_record
    WHERE constraint_record.conrelid = '"WorkSegment"'::regclass
      AND constraint_record.conname = 'WorkSegment_node_requires_task_check'
      AND constraint_record.contype = 'c'
      AND constraint_record.convalidated
      AND NOT constraint_record.connoinherit
      AND pg_get_expr(
        constraint_record.conbin,
        constraint_record.conrelid,
        true
      ) = '"nodeId" IS NULL OR "taskId" IS NOT NULL'
  ) THEN
    RAISE EXCEPTION
      'WorkSegment_node_requires_task_check has an unexpected definition';
  END IF;
END $$;

COMMIT;
