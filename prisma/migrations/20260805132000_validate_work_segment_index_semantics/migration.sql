-- Validate index semantics that are not represented by column order alone.
-- DESC/NULLS options, non-default operator classes and explicit collations can
-- change query behavior while keeping the same index name and key columns.

BEGIN;

DO $$
DECLARE
  actual_definition TEXT;
  expected_definition TEXT;
  actual_options SMALLINT[];
  actual_opclasses_default BOOLEAN;
  actual_opclass_namespaces NAME[];
  actual_collations OID[];
  expected_collations OID[];
BEGIN
  SELECT
    pg_get_indexdef(index_metadata.indexrelid),
    ARRAY(
      SELECT entry.option
      FROM unnest(index_metadata.indoption::SMALLINT[])
        WITH ORDINALITY AS entry(option, position)
      ORDER BY entry.position
    ),
    (
      SELECT bool_and(opclass.opcdefault)
      FROM unnest(index_metadata.indclass::OID[])
        WITH ORDINALITY AS entry(opclass_oid, position)
      JOIN pg_opclass opclass ON opclass.oid = entry.opclass_oid
    ),
    ARRAY(
      SELECT namespace.nspname
      FROM unnest(index_metadata.indclass::OID[])
        WITH ORDINALITY AS entry(opclass_oid, position)
      JOIN pg_opclass opclass ON opclass.oid = entry.opclass_oid
      JOIN pg_namespace namespace ON namespace.oid = opclass.opcnamespace
      ORDER BY entry.position
    ),
    ARRAY(
      SELECT entry.collation_oid
      FROM unnest(index_metadata.indcollation::OID[])
        WITH ORDINALITY AS entry(collation_oid, position)
      ORDER BY entry.position
    ),
    ARRAY(
      SELECT attribute.attcollation
      FROM unnest(index_metadata.indkey::SMALLINT[])
        WITH ORDINALITY AS entry(attnum, position)
      JOIN pg_attribute attribute
        ON attribute.attrelid = index_metadata.indrelid
        AND attribute.attnum = entry.attnum
      ORDER BY entry.position
    )
  INTO
    actual_definition,
    actual_options,
    actual_opclasses_default,
    actual_opclass_namespaces,
    actual_collations,
    expected_collations
  FROM pg_index index_metadata
  JOIN pg_class index_record ON index_record.oid = index_metadata.indexrelid
  JOIN pg_namespace namespace ON namespace.oid = index_record.relnamespace
  WHERE namespace.nspname = current_schema()
    AND index_record.relname = 'WorkSegment_nodeId_type_idx';

  expected_definition := format(
    'CREATE INDEX %I ON %I.%I USING btree ("nodeId", type)',
    'WorkSegment_nodeId_type_idx',
    current_schema(),
    'WorkSegment'
  );

  IF actual_definition IS DISTINCT FROM expected_definition
    OR actual_options IS DISTINCT FROM ARRAY[0, 0]::SMALLINT[]
    OR actual_opclasses_default IS DISTINCT FROM true
    OR actual_opclass_namespaces IS DISTINCT FROM
      ARRAY['pg_catalog', 'pg_catalog']::NAME[]
    OR actual_collations IS DISTINCT FROM expected_collations
  THEN
    RAISE EXCEPTION
      'WorkSegment_nodeId_type_idx has incompatible index semantics: %',
      actual_definition;
  END IF;

  SELECT
    pg_get_indexdef(index_metadata.indexrelid),
    ARRAY(
      SELECT entry.option
      FROM unnest(index_metadata.indoption::SMALLINT[])
        WITH ORDINALITY AS entry(option, position)
      ORDER BY entry.position
    ),
    (
      SELECT bool_and(opclass.opcdefault)
      FROM unnest(index_metadata.indclass::OID[])
        WITH ORDINALITY AS entry(opclass_oid, position)
      JOIN pg_opclass opclass ON opclass.oid = entry.opclass_oid
    ),
    ARRAY(
      SELECT namespace.nspname
      FROM unnest(index_metadata.indclass::OID[])
        WITH ORDINALITY AS entry(opclass_oid, position)
      JOIN pg_opclass opclass ON opclass.oid = entry.opclass_oid
      JOIN pg_namespace namespace ON namespace.oid = opclass.opcnamespace
      ORDER BY entry.position
    ),
    ARRAY(
      SELECT entry.collation_oid
      FROM unnest(index_metadata.indcollation::OID[])
        WITH ORDINALITY AS entry(collation_oid, position)
      ORDER BY entry.position
    ),
    ARRAY(
      SELECT attribute.attcollation
      FROM unnest(index_metadata.indkey::SMALLINT[])
        WITH ORDINALITY AS entry(attnum, position)
      JOIN pg_attribute attribute
        ON attribute.attrelid = index_metadata.indrelid
        AND attribute.attnum = entry.attnum
      ORDER BY entry.position
    )
  INTO
    actual_definition,
    actual_options,
    actual_opclasses_default,
    actual_opclass_namespaces,
    actual_collations,
    expected_collations
  FROM pg_index index_metadata
  JOIN pg_class index_record ON index_record.oid = index_metadata.indexrelid
  JOIN pg_namespace namespace ON namespace.oid = index_record.relnamespace
  WHERE namespace.nspname = current_schema()
    AND index_record.relname =
      'WorkSegment_associationNeedsReview_personId_idx';

  expected_definition := format(
    'CREATE INDEX %I ON %I.%I USING btree ("associationNeedsReview", "personId")',
    'WorkSegment_associationNeedsReview_personId_idx',
    current_schema(),
    'WorkSegment'
  );

  IF actual_definition IS DISTINCT FROM expected_definition
    OR actual_options IS DISTINCT FROM ARRAY[0, 0]::SMALLINT[]
    OR actual_opclasses_default IS DISTINCT FROM true
    OR actual_opclass_namespaces IS DISTINCT FROM
      ARRAY['pg_catalog', 'pg_catalog']::NAME[]
    OR actual_collations IS DISTINCT FROM expected_collations
  THEN
    RAISE EXCEPTION
      'WorkSegment_associationNeedsReview_personId_idx has incompatible index semantics: %',
      actual_definition;
  END IF;
END $$;

COMMIT;
