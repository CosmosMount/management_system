import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260805120000_remove_work_segment_role_and_node_association/migration.sql",
);

test("removes Segment role and Node association data without damaging retained history", async () => {
  const database = await createTemporaryDatabase();
  try {
    await installLegacyFixture(database.client);
    await database.client.query(await readFile(migrationPath, "utf8"));

    const columns = await database.client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'WorkSegment'
      ORDER BY column_name
    `);
    const columnNames = columns.rows.map((row) => row.column_name);
    for (const removedColumn of [
      "role",
      "customRole",
      "nodeId",
      "associationNeedsReview",
    ]) {
      expect(columnNames).not.toContain(removedColumn);
    }

    const removedTypes = await database.client.query<{ typname: string }>(`
      SELECT typname
      FROM pg_type
      WHERE typname = 'WorkSegmentRole'
    `);
    expect(removedTypes.rows).toEqual([]);

    const changeActions = await database.client.query<{ enumlabel: string }>(`
      SELECT enumlabel
      FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE pg_type.typname = 'WorkSegmentChangeAction'
      ORDER BY enumsortorder
    `);
    expect(changeActions.rows.map((row) => row.enumlabel)).toEqual([
      "CREATE",
      "UPDATE",
      "SPLIT",
      "MERGE",
      "CONFIRM",
      "CANCEL",
      "DELETE",
    ]);

    const removedArtifacts = await database.client.query<{
      relink_change: string;
      invalidation_change: string;
      relink_audit: string;
      invalidation_audit: string;
      notification: string;
      outbox: string;
      recipient: string;
    }>(`
      SELECT
        (SELECT count(*) FROM "WorkSegmentChange" WHERE id = 'relink-change')::text AS relink_change,
        (SELECT count(*) FROM "WorkSegmentChange" WHERE id = 'invalidation-change')::text AS invalidation_change,
        (SELECT count(*) FROM "DomainAuditEvent" WHERE id = 'relink-audit')::text AS relink_audit,
        (SELECT count(*) FROM "DomainAuditEvent" WHERE id = 'invalidation-audit')::text AS invalidation_audit,
        (SELECT count(*) FROM "InAppNotification" WHERE id = 'association-notification')::text AS notification,
        (SELECT count(*) FROM "NotificationOutbox" WHERE id = 'association-outbox')::text AS outbox,
        (SELECT count(*) FROM "NotificationOutboxRecipient" WHERE id = 'association-recipient')::text AS recipient
    `);
    expect(removedArtifacts.rows[0]).toEqual({
      relink_change: "0",
      invalidation_change: "0",
      relink_audit: "0",
      invalidation_audit: "0",
      notification: "0",
      outbox: "0",
      recipient: "0",
    });

    const retained = await database.client.query<{
      id: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>(`
      SELECT "id", "before", "after"
      FROM "WorkSegmentChange"
      WHERE id IN ('retained-change', 'same-reason-change')
      ORDER BY id
    `);
    expect(retained.rows).toEqual([
      {
        id: "retained-change",
        before: { content: "旧内容", nested: { nodeId: "nested-is-unrelated" } },
        after: { content: "新内容" },
      },
      {
        id: "same-reason-change",
        before: { content: "旧内容" },
        after: { content: "普通更新" },
      },
    ]);

    const retainedAudit = await database.client.query<{
      id: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }>(`
      SELECT "id", "before", "after"
      FROM "DomainAuditEvent"
      WHERE id IN ('retained-audit', 'retained-segment-audit', 'same-reason-audit')
      ORDER BY id
    `);
    expect(retainedAudit.rows).toEqual([
      {
        id: "retained-audit",
        before: { title: "保留", role: "OWNER", nodeId: "legacy-node" },
        after: {
          title: "仍保留",
          customRole: "职责",
          associationNeedsReview: true,
        },
      },
      {
        id: "retained-segment-audit",
        before: { content: "旧内容" },
        after: { content: "新内容" },
      },
      {
        id: "same-reason-audit",
        before: { content: "旧内容" },
        after: { content: "普通更新" },
      },
    ]);

    const guards = await database.client.query<{ tgname: string }>(`
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = '"DomainAuditEvent"'::regclass
        AND NOT tgisinternal
      ORDER BY tgname
    `);
    expect(guards.rows.map((row) => row.tgname)).toEqual([
      "DomainAuditEvent_prevent_delete",
      "DomainAuditEvent_prevent_update",
    ]);
    await expect(
      database.client.query(
        `DELETE FROM "DomainAuditEvent" WHERE id = 'retained-audit'`,
      ),
    ).rejects.toThrow(/append-only/);

    await database.client.query(`DELETE FROM "TaskNode" WHERE id = 'legacy-node'`);
    const retainedCounts = await database.client.query<{
      segment: string;
      change: string;
      audit: string;
      notification: string;
      outbox: string;
      recipient: string;
    }>(`
      SELECT
        (SELECT count(*) FROM "WorkSegment" WHERE id = 'segment')::text AS segment,
        (SELECT count(*) FROM "WorkSegmentChange" WHERE id = 'retained-change')::text AS change,
        (SELECT count(*) FROM "DomainAuditEvent" WHERE id = 'retained-audit')::text AS audit,
        (SELECT count(*) FROM "InAppNotification" WHERE id = 'retained-notification')::text AS notification,
        (SELECT count(*) FROM "NotificationOutbox" WHERE id = 'retained-outbox')::text AS outbox,
        (SELECT count(*) FROM "NotificationOutboxRecipient" WHERE id = 'retained-recipient')::text AS recipient
    `);
    expect(retainedCounts.rows[0]).toEqual({
      segment: "1",
      change: "1",
      audit: "1",
      notification: "1",
      outbox: "1",
      recipient: "1",
    });
  } finally {
    await database.cleanup();
  }
});

async function installLegacyFixture(client: Client) {
  await client.query(`
    CREATE TYPE "WorkSegmentRole" AS ENUM (
      'OWNER', 'LEAD', 'DEVELOPER', 'DESIGNER', 'REVIEWER', 'SUPPORT', 'OBSERVER', 'CUSTOM'
    );
    CREATE TYPE "WorkSegmentChangeAction" AS ENUM (
      'CREATE', 'UPDATE', 'SPLIT', 'MERGE', 'CONFIRM', 'CANCEL', 'DELETE', 'RELINK'
    );

    CREATE TABLE "TaskNode" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "WorkSegment" (
      "id" TEXT PRIMARY KEY,
      "taskId" TEXT,
      "role" "WorkSegmentRole" NOT NULL DEFAULT 'DEVELOPER',
      "customRole" TEXT,
      "nodeId" TEXT,
      "associationNeedsReview" BOOLEAN NOT NULL DEFAULT false,
      CONSTRAINT "WorkSegment_nodeId_fkey"
        FOREIGN KEY ("nodeId") REFERENCES "TaskNode"("id") ON DELETE SET NULL,
      CONSTRAINT "WorkSegment_custom_role_check"
        CHECK ("role" <> 'CUSTOM' OR length(btrim(coalesce("customRole", ''))) > 0),
      CONSTRAINT "WorkSegment_node_requires_task_check"
        CHECK ("nodeId" IS NULL OR "taskId" IS NOT NULL)
    );
    CREATE INDEX "WorkSegment_nodeId_type_idx" ON "WorkSegment"("nodeId", "role");
    CREATE INDEX "WorkSegment_associationNeedsReview_personId_idx"
      ON "WorkSegment"("associationNeedsReview", "id");

    CREATE TABLE "WorkSegmentChange" (
      "id" TEXT PRIMARY KEY,
      "segmentId" TEXT NOT NULL REFERENCES "WorkSegment"("id") ON DELETE RESTRICT,
      "action" "WorkSegmentChangeAction" NOT NULL,
      "before" JSONB,
      "after" JSONB,
      "reason" TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE "DomainAuditEvent" (
      "id" TEXT PRIMARY KEY,
      "action" TEXT NOT NULL,
      "entityType" TEXT NOT NULL,
      "before" JSONB,
      "after" JSONB,
      "reason" TEXT NOT NULL DEFAULT ''
    );
    CREATE FUNCTION "prevent_domain_audit_event_mutation"()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'DomainAuditEvent is append-only';
    END;
    $$;
    CREATE TRIGGER "DomainAuditEvent_prevent_update"
      BEFORE UPDATE ON "DomainAuditEvent"
      FOR EACH ROW EXECUTE FUNCTION "prevent_domain_audit_event_mutation"();
    CREATE TRIGGER "DomainAuditEvent_prevent_delete"
      BEFORE DELETE ON "DomainAuditEvent"
      FOR EACH ROW EXECUTE FUNCTION "prevent_domain_audit_event_mutation"();

    CREATE TABLE "InAppNotification" (
      "id" TEXT PRIMARY KEY,
      "eventKey" TEXT,
      "payload" JSONB NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "NotificationOutbox" (
      "id" TEXT PRIMARY KEY,
      "eventKey" TEXT NOT NULL,
      "type" TEXT NOT NULL
    );
    CREATE TABLE "NotificationOutboxRecipient" (
      "id" TEXT PRIMARY KEY,
      "outboxId" TEXT NOT NULL REFERENCES "NotificationOutbox"("id") ON DELETE CASCADE
    );

    INSERT INTO "TaskNode" ("id") VALUES ('legacy-node');
    INSERT INTO "WorkSegment" (
      "id", "taskId", "role", "customRole", "nodeId", "associationNeedsReview"
    ) VALUES ('segment', 'task', 'CUSTOM', '开发职责', 'legacy-node', true);
    INSERT INTO "WorkSegmentChange" (
      "id", "segmentId", "action", "before", "after", "reason"
    ) VALUES
      ('relink-change', 'segment', 'RELINK', '{}', '{}', '重关联'),
      (
        'invalidation-change', 'segment', 'UPDATE',
        '{"associationNeedsReview":false}',
        '{"associationNeedsReview":true}',
        'Revision 生效后原关联节点失效'
      ),
      (
        'same-reason-change', 'segment', 'UPDATE',
        '{"content":"旧内容","associationNeedsReview":false}',
        '{"content":"普通更新","associationNeedsReview":false}',
        'Revision 生效后原关联节点失效'
      ),
      (
        'retained-change', 'segment', 'UPDATE',
        '{"content":"旧内容","role":"CUSTOM","customRole":"开发职责","nodeId":"legacy-node","associationNeedsReview":true,"nested":{"nodeId":"nested-is-unrelated"}}',
        '{"content":"新内容","role":"DEVELOPER","customRole":null,"nodeId":null,"associationNeedsReview":false}',
        '普通更新'
      );
    INSERT INTO "DomainAuditEvent" (
      "id", "action", "entityType", "before", "after", "reason"
    ) VALUES
      ('relink-audit', 'pm.segment.relink', 'WorkSegment', '{}', '{}', '重关联'),
      (
        'invalidation-audit', 'pm.segment.update', 'WorkSegment',
        '{"associationNeedsReview":false}',
        '{"associationNeedsReview":true}',
        'Revision 生效后原关联节点失效'
      ),
      (
        'retained-audit', 'pm.task.update', 'Task',
        '{"title":"保留","role":"OWNER","nodeId":"legacy-node"}',
        '{"title":"仍保留","customRole":"职责","associationNeedsReview":true}',
        '普通审计'
      ),
      (
        'retained-segment-audit', 'pm.segment.update', 'WorkSegment',
        '{"content":"旧内容","role":"OWNER","nodeId":"legacy-node"}',
        '{"content":"新内容","customRole":"职责","associationNeedsReview":true}',
        '普通审计'
      ),
      (
        'same-reason-audit', 'pm.segment.update', 'WorkSegment',
        '{"content":"旧内容","associationNeedsReview":false}',
        '{"content":"普通更新","associationNeedsReview":false}',
        'Revision 生效后原关联节点失效'
      );
    INSERT INTO "InAppNotification" ("id", "eventKey", "payload") VALUES
      ('association-notification', 'pm:segment:association_invalidated:revision:inapp:account', '{"kind":"segment_association_invalidated"}'),
      ('retained-notification', 'pm:task:activated:task:inapp:account', '{"kind":"task_activated"}');
    INSERT INTO "NotificationOutbox" ("id", "eventKey", "type") VALUES
      ('association-outbox', 'pm:segment:association_invalidated:revision:feishu', 'segment_association_invalidated'),
      ('retained-outbox', 'pm:task:activated:task:feishu', 'task_activated');
    INSERT INTO "NotificationOutboxRecipient" ("id", "outboxId") VALUES
      ('association-recipient', 'association-outbox'),
      ('retained-recipient', 'retained-outbox');
  `);
}

async function createTemporaryDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const source = new URL(databaseUrl);
  const sourceDatabaseName = source.pathname.replace(/^\//, "");
  if (
    !["127.0.0.1", "localhost", "::1"].includes(source.hostname) ||
    !sourceDatabaseName.endsWith("_test") ||
    /prod(?:uction)?/i.test(sourceDatabaseName)
  ) {
    throw new Error("拒绝在非本机测试数据库执行 Work Segment 删除 migration 回归");
  }

  const databaseName = `segment_removal_${randomUUID().replaceAll("-", "").slice(0, 12)}_test`;
  const adminUrl = new URL(source);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(source);
  targetUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const client = new Client({ connectionString: targetUrl.toString() });
  await client.connect();
  return {
    client,
    cleanup: async () => {
      await client.end().catch(() => undefined);
      await admin.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    },
  };
}
