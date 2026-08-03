import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma/migrations");
const REMOVAL_MIGRATION =
  "20260801110000_remove_resource_conflicts_and_allocation";

test("resource removal migration deletes conflict data and strips allocation without damaging retained records", async () => {
  test.setTimeout(180_000);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sourceUrl = new URL(databaseUrl);
  const sourceDatabaseName = sourceUrl.pathname.replace(/^\//, "");
  if (
    !["127.0.0.1", "localhost", "::1"].includes(sourceUrl.hostname) ||
    !sourceDatabaseName.endsWith("_test") ||
    /prod(?:uction)?/i.test(sourceDatabaseName)
  ) {
    throw new Error("拒绝在非本机测试数据库执行资源删除 migration 回归");
  }

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `${sourceDatabaseName.slice(0, 18)}_${suffix}_resource_removal_test`;
  if (!/^[A-Za-z0-9_]+_resource_removal_test$/.test(databaseName)) {
    throw new Error("资源删除临时数据库名称安全校验失败");
  }
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let target: Client | null = null;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();

    const migrationNames = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter(
        (entry) => entry.isDirectory() && entry.name < REMOVAL_MIGRATION,
      )
      .map((entry) => entry.name)
      .sort();
    expect(migrationNames.length).toBeGreaterThan(0);
    for (const migrationName of migrationNames) {
      const sql = await readFile(
        path.join(MIGRATIONS_DIR, migrationName, "migration.sql"),
        "utf8",
      );
      if (migrationName === "20260731121000_unified_account_backfill") {
        await executeMigrationSqlInTransaction(target, sql);
      } else {
        await executeMigrationSql(target, sql);
      }
    }

    const ids = fixtureIds();
    await seedPreRemovalData(target, ids);
    await executeMigrationSql(
      target,
      await readFile(
        path.join(MIGRATIONS_DIR, REMOVAL_MIGRATION, "migration.sql"),
        "utf8",
      ),
    );

    const removedRelations = await target.query<{ name: string; relation: string | null }>(
      `SELECT name, to_regclass('public."' || name || '"')::text AS relation
       FROM unnest(ARRAY[
         'ResourceConflict',
         'ConflictSegment',
         'ProjectManagementScanCheckpoint'
       ]) AS name
       ORDER BY name`,
    );
    expect(removedRelations.rows).toEqual([
      { name: "ConflictSegment", relation: null },
      { name: "ProjectManagementScanCheckpoint", relation: null },
      { name: "ResourceConflict", relation: null },
    ]);
    const allocationColumn = await target.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'WorkSegment'
         AND column_name = 'allocation'`,
    );
    expect(allocationColumn.rowCount).toBe(0);
    const removedTypes = await target.query<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE typname = ANY($1::text[])`,
      [["ResourceConflictKind", "ResourceConflictSeverity", "ResourceConflictStatus"]],
    );
    expect(removedTypes.rows).toEqual([]);
    const auditGuards = await target.query<{ name: string }>(
      `SELECT tgname AS name
       FROM pg_trigger
       WHERE tgrelid = '"DomainAuditEvent"'::regclass
         AND NOT tgisinternal
       ORDER BY tgname`,
    );
    expect(auditGuards.rows.map((row) => row.name)).toEqual([
      "DomainAuditEvent_prevent_delete",
      "DomainAuditEvent_prevent_update",
    ]);
    const categories = await target.query<{ value: string }>(
      `SELECT enumlabel AS value
       FROM pg_enum
       WHERE enumtypid = '"ProjectManagementNotificationCategory"'::regtype
       ORDER BY enumsortorder`,
    );
    expect(categories.rows.map((row) => row.value)).toEqual([
      "TASK",
      "MILESTONE",
      "REVIEW",
      "REVISION",
      "WORK_SEGMENT",
      "ACCOUNT_SECURITY",
    ]);

    expect(await countById(target, "WorkSegment", ids.segment)).toBe(1);
    expect(await countById(target, "NotificationPreference", ids.keptPreference)).toBe(1);
    expect(await countById(target, "NotificationPreference", ids.conflictPreference)).toBe(0);
    expect(await countById(target, "InAppNotification", ids.keptNotification)).toBe(1);
    expect(await countById(target, "InAppNotification", ids.conflictNotification)).toBe(0);
    expect(await countById(target, "NotificationOutbox", ids.keptOutbox)).toBe(1);
    expect(await countById(target, "NotificationOutbox", ids.openedOutbox)).toBe(0);
    expect(await countById(target, "NotificationOutbox", ids.resolvedOutbox)).toBe(0);
    expect(await countById(target, "NotificationOutboxRecipient", ids.keptRecipient)).toBe(1);
    expect(await countById(target, "NotificationOutboxRecipient", ids.conflictRecipient)).toBe(0);
    expect(await countById(target, "DomainAuditEvent", ids.conflictAudit)).toBe(0);
    expect(await countById(target, "DomainAuditEvent", ids.segmentAudit)).toBe(1);
    expect(await countById(target, "DomainAuditEvent", ids.taskAudit)).toBe(1);

    const change = await target.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT "before", "after" FROM "WorkSegmentChange" WHERE id = $1`,
      [ids.change],
    );
    expect(change.rows[0]).toEqual({
      before: { content: "迁移前", nested: { allocation: 25 } },
      after: { content: "迁移后", nested: { allocation: 50 } },
    });
    const segmentAudit = await target.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT "before", "after" FROM "DomainAuditEvent" WHERE id = $1`,
      [ids.segmentAudit],
    );
    expect(segmentAudit.rows[0]).toEqual({
      before: { content: "迁移前" },
      after: { content: "迁移后" },
    });
  } finally {
    if (target) await target.end().catch(() => undefined);
    await admin.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
});

type FixtureIds = ReturnType<typeof fixtureIds>;

function fixtureIds() {
  return {
    account: randomUUID(),
    person: randomUUID(),
    segment: randomUUID(),
    change: randomUUID(),
    conflict: randomUUID(),
    conflictSegment: randomUUID(),
    conflictPreference: randomUUID(),
    keptPreference: randomUUID(),
    conflictNotification: randomUUID(),
    keptNotification: randomUUID(),
    openedOutbox: randomUUID(),
    resolvedOutbox: randomUUID(),
    keptOutbox: randomUUID(),
    conflictRecipient: randomUUID(),
    keptRecipient: randomUUID(),
    conflictAudit: randomUUID(),
    segmentAudit: randomUUID(),
    taskAudit: randomUUID(),
  };
}

async function seedPreRemovalData(client: Client, ids: FixtureIds) {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO "Account" (id, "updatedAt") VALUES ($1, CURRENT_TIMESTAMP)`,
      [ids.account],
    );
    await client.query(
      `INSERT INTO "Person" (id, "accountId", "displayName", status, "updatedAt")
       VALUES ($1, $2, '迁移保留人员', 'ACTIVE', CURRENT_TIMESTAMP)`,
      [ids.person, ids.account],
    );
    await client.query(
      `INSERT INTO "WorkSegment" (
         id, "personId", type, status, "startAt", "endAt", content,
         allocation, "createdByAccountId", "updatedAt"
       ) VALUES (
         $1, $2, 'PLANNED', 'PLANNED',
         '2026-08-01T01:00:00Z', '2026-08-01T03:00:00Z',
         '迁移后必须保留', 75, $3, CURRENT_TIMESTAMP
       )`,
      [ids.segment, ids.person, ids.account],
    );
    await client.query(
      `INSERT INTO "WorkSegmentChange" (id, "segmentId", action, "before", "after", reason)
       VALUES ($1, $2, 'UPDATE', $3::jsonb, $4::jsonb, '保留 Segment 历史')`,
      [
        ids.change,
        ids.segment,
        JSON.stringify({ content: "迁移前", allocation: 25, nested: { allocation: 25 } }),
        JSON.stringify({ content: "迁移后", allocation: 50, nested: { allocation: 50 } }),
      ],
    );
    await client.query(
      `INSERT INTO "ResourceConflict" (
         id, "personId", kind, "startAt", "endAt", severity, status,
         fingerprint, "updatedAt"
       ) VALUES (
         $1, $2, 'ALLOCATION_OVER_LIMIT',
         '2026-08-01T01:30:00Z', '2026-08-01T02:30:00Z',
         'HIGH', 'OPEN', $3, CURRENT_TIMESTAMP
       )`,
      [ids.conflict, ids.person, `migration-${ids.conflict}`],
    );
    await client.query(
      `INSERT INTO "ConflictSegment" (id, "conflictId", "segmentId") VALUES ($1, $2, $3)`,
      [ids.conflictSegment, ids.conflict, ids.segment],
    );
    await client.query(
      `INSERT INTO "NotificationPreference" (id, "accountId", category, channel, enabled, "updatedAt")
       VALUES
         ($1, $3, 'RESOURCE_CONFLICT', 'IN_APP', true, CURRENT_TIMESTAMP),
         ($2, $3, 'TASK', 'IN_APP', true, CURRENT_TIMESTAMP)`,
      [ids.conflictPreference, ids.keptPreference, ids.account],
    );
    await client.query(
      `INSERT INTO "InAppNotification" (
         id, "eventKey", "recipientAccountId", category, title, "entityType", "entityId"
       ) VALUES
         ($1, 'migration-conflict-notification', $3, 'RESOURCE_CONFLICT', '冲突通知', 'ResourceConflict', $4),
         ($2, 'migration-task-notification', $3, 'TASK', '普通通知', 'Task', 'kept-task')`,
      [ids.conflictNotification, ids.keptNotification, ids.account, ids.conflict],
    );
    await client.query(
      `INSERT INTO "NotificationOutbox" (
         id, "eventKey", channel, type, payload, "updatedAt"
       ) VALUES
         ($1, 'migration-conflict-opened', 'project-management', 'resource_conflict_opened', '{}', CURRENT_TIMESTAMP),
         ($2, 'migration-conflict-resolved', 'project-management', 'resource_conflict_resolved', '{}', CURRENT_TIMESTAMP),
         ($3, 'migration-task-activated', 'project-management', 'task_activated', '{}', CURRENT_TIMESTAMP)`,
      [ids.openedOutbox, ids.resolvedOutbox, ids.keptOutbox],
    );
    await client.query(
      `INSERT INTO "NotificationOutboxRecipient" (id, "outboxId", "openId", "updatedAt")
       VALUES
         ($1, $2, 'ou_conflict', CURRENT_TIMESTAMP),
         ($3, $4, 'ou_kept', CURRENT_TIMESTAMP)`,
      [ids.conflictRecipient, ids.openedOutbox, ids.keptRecipient, ids.keptOutbox],
    );
    await client.query(
      `INSERT INTO "ProjectManagementScanCheckpoint" (key)
       VALUES ('resource-conflict-incremental-v1')`,
    );
    await client.query(
      `INSERT INTO "DomainAuditEvent" (
         id, action, "entityType", "entityId", "before", "after", reason
       ) VALUES
         ($1, 'pm.conflict.open', 'ResourceConflict', $4, '{}', '{}', '删除冲突审计'),
         ($2, 'pm.segment.update', 'WorkSegment', $5, $6::jsonb, $7::jsonb, '保留并清理比例'),
         ($3, 'pm.task.update', 'Task', 'kept-task', '{"title":"旧"}', '{"title":"新"}', '完整保留')`,
      [
        ids.conflictAudit,
        ids.segmentAudit,
        ids.taskAudit,
        ids.conflict,
        ids.segment,
        JSON.stringify({ content: "迁移前", allocation: 25 }),
        JSON.stringify({ content: "迁移后", allocation: 50 }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function countById(client: Client, table: string, id: string) {
  if (!/^[A-Za-z]+$/.test(table)) throw new Error("非法测试表名");
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "${table}" WHERE id = $1`,
    [id],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function executeMigrationSql(client: Client, sql: string) {
  for (const statement of splitPostgresStatements(sql)) {
    await client.query(statement);
  }
}

async function executeMigrationSqlInTransaction(client: Client, sql: string) {
  await client.query("BEGIN");
  try {
    await executeMigrationSql(client, sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function splitPostgresStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  let dollarQuoteTag: string | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    current += char;

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === "/" && next === "*") {
        current += next;
        index += 1;
        blockCommentDepth += 1;
      } else if (char === "*" && next === "/") {
        current += next;
        index += 1;
        blockCommentDepth -= 1;
      }
      continue;
    }
    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, index)) {
        current += dollarQuoteTag.slice(1);
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }
    if (singleQuoted) {
      if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (doubleQuoted) {
      if (char === '"' && next === '"') {
        current += next;
        index += 1;
      } else if (char === '"') {
        doubleQuoted = false;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      current += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      current += next;
      index += 1;
      blockCommentDepth = 1;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
      continue;
    }
    if (char === '"') {
      doubleQuoted = true;
      continue;
    }
    if (char === "$") {
      const tag = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        current += tag.slice(1);
        index += tag.length - 1;
        dollarQuoteTag = tag;
        continue;
      }
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    }
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}
