// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const repairMigrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260805130000_repair_work_segment_schema_drift/migration.sql",
);
const validationMigrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260805131000_validate_work_segment_schema_repair/migration.sql",
);
const indexValidationMigrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260805132000_validate_work_segment_index_semantics/migration.sql",
);

test("WorkSegment schema drift repair preserves legacy rows and is a catalog no-op when repeated", async () => {
  await withTestClient(async (client) => {
    const schemaName = await createLegacySchema(client);
    try {
      await setSearchPath(client, schemaName);
      await client.query(`
        INSERT INTO "WorkSegment" (
          id,
          "personId",
          type,
          "taskId",
          content
        ) VALUES (
          'legacy-segment',
          'legacy-person',
          'PLANNED',
          'legacy-task',
          '既有投入内容'
        )
      `);

      await applyRepairAndValidation(client);

      await expect(
        client.query(`
          SELECT
            id,
            "personId",
            type,
            "taskId",
            content,
            role::TEXT AS role,
            "customRole",
            "nodeId",
            "associationNeedsReview"
          FROM "WorkSegment"
          WHERE id = 'legacy-segment'
        `),
      ).resolves.toMatchObject({
        rows: [
          {
            id: "legacy-segment",
            personId: "legacy-person",
            type: "PLANNED",
            taskId: "legacy-task",
            content: "既有投入内容",
            role: "DEVELOPER",
            customRole: null,
            nodeId: null,
            associationNeedsReview: false,
          },
        ],
      });

      const beforeRepeat = await loadCatalogAndDataSnapshot(client, schemaName);
      await applyRepairAndValidation(client);
      const afterRepeat = await loadCatalogAndDataSnapshot(client, schemaName);
      expect(afterRepeat).toEqual(beforeRepeat);

      await expectConstraintBehavior(client);
    } finally {
      await dropTestSchema(client, schemaName);
    }
  });
});

test("WorkSegment repair completes partial drift and validation rejects same-name invalid objects", async () => {
  await withTestClient(async (client) => {
    const partialSchema = await createLegacySchema(client, { partialRepair: true });
    try {
      await setSearchPath(client, partialSchema);
      await applyRepairAndValidation(client);
      await expectCatalogShape(client, partialSchema);
    } finally {
      await dropTestSchema(client, partialSchema);
    }

    for (const corruption of [
      "FIELD",
      "INDEX",
      "CHECK",
      "FOREIGN_KEY",
      "INDEX_DESC",
      "INDEX_OPCLASS",
    ] as const) {
      const schemaName = await createLegacySchema(client);
      try {
        await setSearchPath(client, schemaName);
        await applyMigration(client, repairMigrationPath);

        if (corruption === "FIELD") {
          await client.query(`
            ALTER TABLE "WorkSegment"
              ALTER COLUMN "associationNeedsReview" SET DEFAULT true
          `);
        } else if (corruption === "INDEX") {
          await client.query(`
            DROP INDEX "WorkSegment_nodeId_type_idx";
            CREATE INDEX "WorkSegment_nodeId_type_idx"
              ON "WorkSegment"(type, "nodeId")
          `);
        } else if (corruption === "CHECK") {
          await client.query(`
            ALTER TABLE "WorkSegment"
              DROP CONSTRAINT "WorkSegment_node_requires_task_check";
            ALTER TABLE "WorkSegment"
              ADD CONSTRAINT "WorkSegment_node_requires_task_check"
              CHECK (true)
          `);
        } else if (corruption === "FOREIGN_KEY") {
          await client.query(`
            ALTER TABLE "WorkSegment"
              DROP CONSTRAINT "WorkSegment_nodeId_fkey";
            ALTER TABLE "WorkSegment"
              ADD CONSTRAINT "WorkSegment_nodeId_fkey"
              FOREIGN KEY ("nodeId") REFERENCES "TaskNode"(id)
              ON UPDATE NO ACTION ON DELETE RESTRICT
          `);
        } else if (corruption === "INDEX_DESC") {
          await client.query(`
            DROP INDEX "WorkSegment_nodeId_type_idx";
            CREATE INDEX "WorkSegment_nodeId_type_idx"
              ON "WorkSegment"("nodeId" DESC, type)
          `);
        } else {
          await client.query(`
            DROP INDEX "WorkSegment_nodeId_type_idx";
            CREATE INDEX "WorkSegment_nodeId_type_idx"
              ON "WorkSegment"("nodeId" text_pattern_ops, type)
          `);
        }

        const semanticIndexCorruption =
          corruption === "INDEX_DESC" || corruption === "INDEX_OPCLASS";
        if (semanticIndexCorruption) {
          await applyMigration(client, validationMigrationPath);
        }
        const beforeValidation = await loadCatalogAndDataSnapshot(
          client,
          schemaName,
        );
        const expectedError =
          corruption === "FIELD"
            ? /associationNeedsReview has an unexpected definition/
            : corruption === "INDEX"
              ? /nodeId_type_idx has an unexpected definition/
              : corruption === "CHECK"
                ? /node_requires_task_check has an unexpected definition/
                : corruption === "FOREIGN_KEY"
                  ? /nodeId_fkey has an unexpected definition/
                  : /nodeId_type_idx has incompatible index semantics/;
        let validationError: unknown;
        try {
          await applyMigration(
            client,
            semanticIndexCorruption
              ? indexValidationMigrationPath
              : validationMigrationPath,
          );
        } catch (error) {
          validationError = error;
          await client.query("ROLLBACK");
        }
        expect(validationError).toBeInstanceOf(Error);
        expect((validationError as Error).message).toMatch(expectedError);
        const afterValidation = await loadCatalogAndDataSnapshot(
          client,
          schemaName,
        );
        expect(afterValidation).toEqual(beforeValidation);
      } finally {
        await dropTestSchema(client, schemaName);
      }
    }
  });
});

async function withTestClient(run: (client: Client) => Promise<void>) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname) ||
    !parsedDatabaseUrl.pathname.endsWith("_test")
  ) {
    throw new Error("WorkSegment 漂移修复测试只允许使用 runner 持有的本机 _test 数据库");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("SET search_path TO public");
    await client.end();
  }
}

async function createLegacySchema(
  client: Client,
  options: { partialRepair?: boolean } = {},
) {
  const schemaName = `work_segment_repair_${randomUUID().replaceAll("-", "")}`;
  await client.query(`CREATE SCHEMA "${schemaName}"`);
  await setSearchPath(client, schemaName);
  await client.query(`
    CREATE TYPE "WorkSegmentChangeAction" AS ENUM (
      'CREATE', 'UPDATE', 'SPLIT', 'MERGE', 'CONFIRM', 'CANCEL', 'DELETE'
      ${options.partialRepair ? ", 'RELINK'" : ""}
    );
    CREATE TABLE "TaskNode" (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE "WorkSegment" (
      id TEXT PRIMARY KEY,
      "personId" TEXT NOT NULL,
      type TEXT NOT NULL,
      "taskId" TEXT,
      content TEXT NOT NULL
    );
  `);

  if (options.partialRepair) {
    await client.query(`
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
      ALTER TABLE "WorkSegment"
        ADD COLUMN role "WorkSegmentRole" NOT NULL DEFAULT 'DEVELOPER',
        ADD COLUMN "nodeId" TEXT;
    `);
  }

  return schemaName;
}

async function setSearchPath(client: Client, schemaName: string) {
  await client.query(`SET search_path TO "${schemaName}"`);
}

async function dropTestSchema(client: Client, schemaName: string) {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.query("SET search_path TO public");
  await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
}

async function applyRepairAndValidation(client: Client) {
  await applyMigration(client, repairMigrationPath);
  await applyMigration(client, validationMigrationPath);
  await applyMigration(client, indexValidationMigrationPath);
}

async function applyMigration(client: Client, migrationPath: string) {
  await client.query(await readFile(migrationPath, "utf8"));
}

async function loadCatalogAndDataSnapshot(client: Client, schemaName: string) {
  const columns = await client.query(`
      SELECT
        column_name,
        data_type,
        udt_schema,
        udt_name,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'WorkSegment'
      ORDER BY ordinal_position
    `, [schemaName]);
  const enums = await client.query(`
      SELECT type.typname, enum.enumlabel, enum.enumsortorder
      FROM pg_enum enum
      JOIN pg_type type ON type.oid = enum.enumtypid
      JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = $1
      ORDER BY type.typname, enum.enumsortorder
    `, [schemaName]);
  const indexes = await client.query(`
      SELECT index_record.oid, indexes.indexname, indexes.indexdef
      FROM pg_indexes indexes
      JOIN pg_class index_record ON index_record.relname = indexes.indexname
      JOIN pg_namespace namespace ON namespace.oid = index_record.relnamespace
        AND namespace.nspname = indexes.schemaname
      WHERE indexes.schemaname = $1 AND indexes.tablename = 'WorkSegment'
      ORDER BY indexes.indexname
    `, [schemaName]);
  const constraints = await client.query(`
      SELECT
        constraint_record.oid,
        constraint_record.conname,
        constraint_record.contype,
        constraint_record.confupdtype,
        constraint_record.confdeltype,
        constraint_record.convalidated,
        pg_get_constraintdef(constraint_record.oid, true) AS definition
      FROM pg_constraint constraint_record
      JOIN pg_class table_record ON table_record.oid = constraint_record.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_record.relnamespace
      WHERE namespace.nspname = $1 AND table_record.relname = 'WorkSegment'
      ORDER BY constraint_record.conname
    `, [schemaName]);
  const data = await client.query(`SELECT * FROM "WorkSegment" ORDER BY id`);
  return {
    columns: columns.rows,
    enums: enums.rows,
    indexes: indexes.rows,
    constraints: constraints.rows,
    data: data.rows,
  };
}

async function expectCatalogShape(client: Client, schemaName: string) {
  const snapshot = await loadCatalogAndDataSnapshot(client, schemaName);
  const columns = new Map(
    snapshot.columns.map((column) => [column.column_name, column]),
  );
  expect(columns.get("role")).toMatchObject({
    data_type: "USER-DEFINED",
    udt_schema: schemaName,
    udt_name: "WorkSegmentRole",
    is_nullable: "NO",
    column_default: `'DEVELOPER'::"WorkSegmentRole"`,
  });
  expect(columns.get("customRole")).toMatchObject({
    data_type: "text",
    is_nullable: "YES",
    column_default: null,
  });
  expect(columns.get("nodeId")).toMatchObject({
    data_type: "text",
    is_nullable: "YES",
    column_default: null,
  });
  expect(columns.get("associationNeedsReview")).toMatchObject({
    data_type: "boolean",
    is_nullable: "NO",
    column_default: "false",
  });
  expect(snapshot.indexes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        indexname: "WorkSegment_nodeId_type_idx",
        indexdef: expect.stringMatching(/USING btree \("nodeId", type\)$/),
      }),
      expect.objectContaining({
        indexname: "WorkSegment_associationNeedsReview_personId_idx",
        indexdef: expect.stringMatching(
          /USING btree \("associationNeedsReview", "personId"\)$/,
        ),
      }),
    ]),
  );
  expect(snapshot.constraints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        conname: "WorkSegment_nodeId_fkey",
        contype: "f",
        confupdtype: "c",
        confdeltype: "n",
        convalidated: true,
        definition: expect.stringContaining(
          'REFERENCES "TaskNode"(id) ON UPDATE CASCADE ON DELETE SET NULL',
        ),
      }),
      expect.objectContaining({
        conname: "WorkSegment_custom_role_check",
        contype: "c",
        convalidated: true,
      }),
      expect.objectContaining({
        conname: "WorkSegment_node_requires_task_check",
        contype: "c",
        convalidated: true,
      }),
    ]),
  );
}

async function expectConstraintBehavior(client: Client) {
  await expect(
    client.query(`
      INSERT INTO "WorkSegment" (
        id,
        "personId",
        type,
        "taskId",
        content,
        role,
        "customRole"
      ) VALUES (
        'invalid-custom-role',
        'legacy-person',
        'PLANNED',
        'legacy-task',
        '无自定义角色',
        'CUSTOM',
        NULL
      )
    `),
  ).rejects.toThrow(/WorkSegment_custom_role_check/);
  await expect(
    client.query(`
      INSERT INTO "WorkSegment" (
        id,
        "personId",
        type,
        "taskId",
        content,
        "nodeId"
      ) VALUES (
        'invalid-node-link',
        'legacy-person',
        'PLANNED',
        NULL,
        '无 Task 的节点',
        'missing-node'
      )
    `),
  ).rejects.toThrow(/WorkSegment_node_requires_task_check/);
}
