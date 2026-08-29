// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260804150000_revision_time_marker_refactor/migration.sql",
);

test.describe("Revision time marker migration", () => {
  test("upgrades an empty Revision table, installs the enum and enforces one candidate", async () => {
    const database = await createTemporaryDatabase();
    try {
      await installLegacyRevisionFixture(database.client, false);
      await database.client.query(await readFile(migrationPath, "utf8"));

      const columns = await database.client.query<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(`
        SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'RevisionNode'
      `);
      expect(columns.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ column_name: "revisionAt", is_nullable: "NO" }),
          expect.objectContaining({
            column_name: "reviewRound",
            is_nullable: "NO",
            column_default: "1",
          }),
        ]),
      );
      expect(columns.rows.some((column) => column.column_name === "submittedAt")).toBe(false);
      expect(columns.rows.some((column) => column.column_name === "revisedFromNodeId")).toBe(false);

      const enumValues = await database.client.query<{ enumlabel: string }>(`
        SELECT enumlabel
        FROM pg_enum
        JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
        WHERE pg_type.typname = 'RevisionStatus'
        ORDER BY enumsortorder
      `);
      expect(enumValues.rows.map((row) => row.enumlabel)).toEqual([
        "PENDING_APPROVAL",
        "EFFECTIVE",
        "REJECTED",
        "CANCELLED",
      ]);

      await database.client.query(`
        INSERT INTO "TaskPlanVersion" ("id", "taskId", "status", "revisionNodeId")
        VALUES ('candidate-1', 'task-1', 'DRAFT', 'revision-1')
      `);
      await expect(
        database.client.query(`
          INSERT INTO "TaskPlanVersion" ("id", "taskId", "status", "revisionNodeId")
          VALUES ('candidate-2', 'task-1', 'DRAFT', 'revision-2')
        `),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await database.cleanup();
    }
  });

  test("fails before destructive changes when Revision data exists", async () => {
    const database = await createTemporaryDatabase();
    try {
      await installLegacyRevisionFixture(database.client, true);
      await expect(
        database.client.query(await readFile(migrationPath, "utf8")),
      ).rejects.toThrow(/requires an empty RevisionNode table/);

      const columns = await database.client.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'RevisionNode'
      `);
      const names = columns.rows.map((column) => column.column_name);
      expect(names).toContain("submittedAt");
      expect(names).toContain("revisedFromNodeId");
      expect(names).not.toContain("revisionAt");
      expect(names).not.toContain("reviewRound");
    } finally {
      await database.cleanup();
    }
  });
});

async function installLegacyRevisionFixture(client: Client, withRevision: boolean) {
  await client.query(`
    CREATE TYPE "RevisionStatus" AS ENUM (
      'DRAFT', 'PENDING_APPROVAL', 'EFFECTIVE', 'REJECTED', 'CANCELLED'
    );
    CREATE TABLE "TaskNode" (
      "id" TEXT PRIMARY KEY
    );
    CREATE TABLE "TaskPlanVersion" (
      "id" TEXT PRIMARY KEY,
      "taskId" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "revisionNodeId" TEXT
    );
    CREATE TABLE "RevisionNode" (
      "id" TEXT PRIMARY KEY,
      "nodeId" TEXT NOT NULL UNIQUE,
      "reason" TEXT NOT NULL,
      "revisedFromNodeId" TEXT,
      "submittedAt" TIMESTAMPTZ(6),
      "status" "RevisionStatus" NOT NULL DEFAULT 'DRAFT',
      CONSTRAINT "RevisionNode_revisedFromNodeId_fkey"
        FOREIGN KEY ("revisedFromNodeId") REFERENCES "TaskNode"("id")
    );
  `);
  if (!withRevision) return;
  await client.query(`
    INSERT INTO "TaskNode" ("id") VALUES ('revision-node'), ('revision-origin');
    INSERT INTO "RevisionNode" (
      "id", "nodeId", "reason", "revisedFromNodeId", "status"
    ) VALUES (
      'revision-1', 'revision-node', 'legacy revision', 'revision-origin', 'DRAFT'
    )
  `);
}

async function createTemporaryDatabase() {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL is required");
  const source = new URL(sourceUrl);
  if (!source.pathname.endsWith("_test")) {
    throw new Error("Revision migration tests require a runner-owned _test database");
  }
  const databaseName = `revision_marker_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
  const adminUrl = new URL(source);
  adminUrl.pathname = "/postgres";
  const databaseUrl = new URL(source);
  databaseUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const client = new Client({ connectionString: databaseUrl.toString() });
  await client.connect();
  return {
    client,
    cleanup: async () => {
      await client.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    },
  };
}
