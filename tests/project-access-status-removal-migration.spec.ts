import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma/migrations");
const REMOVAL_MIGRATION = "20260803190000_remove_project_access_status";

test("project access status removal restores disabled accounts without notification side effects", async () => {
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
    throw new Error("拒绝在非本机测试数据库执行项目访问状态删除 migration 回归");
  }

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `${sourceDatabaseName.slice(0, 18)}_${suffix}_access_removal_test`;
  if (!/^[A-Za-z0-9_]+_access_removal_test$/.test(databaseName)) {
    throw new Error("项目访问状态删除临时数据库名称安全校验失败");
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
      .filter((entry) => entry.isDirectory() && entry.name < REMOVAL_MIGRATION)
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

    const activeAccountId = randomUUID();
    const disabledAccountIds = [randomUUID(), randomUUID()];
    await target.query(
      `INSERT INTO "Account" (id, "projectAccessStatus", "updatedAt")
       VALUES ($1, 'ACTIVE', CURRENT_TIMESTAMP),
              ($2, 'DISABLED', CURRENT_TIMESTAMP),
              ($3, 'DISABLED', CURRENT_TIMESTAMP)`,
      [activeAccountId, ...disabledAccountIds],
    );
    await target.query(
      `INSERT INTO "InAppNotification" (
         id, "eventKey", "recipientAccountId", category, title, "entityType", "entityId"
       ) VALUES ($1, $2, $3, 'ACCOUNT_SECURITY', '既有通知', 'Account', $3)`,
      [randomUUID(), `existing-in-app:${activeAccountId}`, activeAccountId],
    );
    await target.query(
      `INSERT INTO "NotificationOutbox" (
         id, "eventKey", channel, type, payload, "updatedAt"
       ) VALUES ($1, $2, 'project-management', 'existing_event', '{}', CURRENT_TIMESTAMP)`,
      [randomUUID(), `existing-outbox:${activeAccountId}`],
    );
    const beforeCounts = await notificationCounts(target);

    await executeMigrationSql(
      target,
      await readFile(
        path.join(MIGRATIONS_DIR, REMOVAL_MIGRATION, "migration.sql"),
        "utf8",
      ),
    );

    const audits = await target.query<{
      entityId: string;
      action: string;
      entityType: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      reason: string;
      source: string;
    }>(
      `SELECT "entityId", action, "entityType", before, after, reason, source::text
       FROM "DomainAuditEvent"
       WHERE action = 'account.project_access.removed'
       ORDER BY "entityId"`,
    );
    expect(audits.rows).toEqual(
      [...disabledAccountIds]
        .sort()
        .map((entityId) => ({
          entityId,
          action: "account.project_access.removed",
          entityType: "Account",
          before: { projectAccessStatus: "DISABLED" },
          after: { projectAccessStatus: null, projectAccessRestored: true },
          reason: "项目访问禁用机制已移除；账号恢复项目入口；不发送用户通知",
          source: "MIGRATION",
        })),
    );
    expect(audits.rows.some((audit) => audit.entityId === activeAccountId)).toBe(false);
    expect(await notificationCounts(target)).toEqual(beforeCounts);

    const removedColumn = await target.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'Account'
         AND column_name = 'projectAccessStatus'`,
    );
    expect(removedColumn.rowCount).toBe(0);
    const removedEnum = await target.query(
      `SELECT 1 FROM pg_type WHERE typname = 'AccountStatus'`,
    );
    expect(removedEnum.rowCount).toBe(0);

    const administratorGuards = await target.query<{
      tableName: string;
      triggerName: string;
    }>(
      `SELECT event_object_table AS "tableName", trigger_name AS "triggerName"
       FROM information_schema.triggers
       WHERE trigger_schema = 'public'
         AND (
           trigger_name LIKE '%usable_global_administrator%'
           OR trigger_name LIKE '%global_administrator%_guard_v2'
         )
       ORDER BY event_object_table, trigger_name`,
    );
    expect(administratorGuards.rows).toEqual([
      {
        tableName: "Account",
        triggerName: "Account_usable_global_administrator_delete_guard_v2",
      },
      {
        tableName: "AccountIdentity",
        triggerName: "AccountIdentity_usable_global_administrator_delete_guard_v2",
      },
      {
        tableName: "AccountIdentity",
        triggerName: "AccountIdentity_usable_global_administrator_update_guard_v2",
      },
      {
        tableName: "SystemRoleAssignment",
        triggerName: "SystemRoleAssignment_global_administrator_delete_guard_v2",
      },
      {
        tableName: "SystemRoleAssignment",
        triggerName: "SystemRoleAssignment_global_administrator_update_guard_v2",
      },
      {
        tableName: "Task",
        triggerName: "Task_usable_global_administrator_insert_guard_v2",
      },
    ]);
    expect(
      administratorGuards.rows.some(
        ({ triggerName }) =>
          triggerName === "Account_usable_global_administrator_update_guard_v2",
      ),
    ).toBe(false);
    const guardFunction = await target.query<{ definition: string }>(
      `SELECT pg_get_functiondef(oid) AS definition
       FROM pg_proc
       WHERE proname = 'assert_usable_global_approval_administrator_v2'`,
    );
    expect(guardFunction.rows).toHaveLength(1);
    expect(guardFunction.rows[0]?.definition).not.toContain(
      "projectAccessStatus",
    );

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
    await expect(
      target.query(
        `UPDATE "DomainAuditEvent" SET reason = '不可修改'
         WHERE action = 'account.project_access.removed'`,
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      target.query(
        `DELETE FROM "DomainAuditEvent"
         WHERE action = 'account.project_access.removed'`,
      ),
    ).rejects.toThrow(/append-only/i);
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

async function notificationCounts(client: Client) {
  const result = await client.query<{
    inApp: string;
    outbox: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM "InAppNotification") AS "inApp",
       (SELECT count(*)::text FROM "NotificationOutbox") AS outbox`,
  );
  return result.rows[0];
}

async function executeMigrationSql(client: Client, sql: string) {
  const lines = sql.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes("BEGIN;") && lines.includes("COMMIT;")) {
    await client.query(sql);
    return;
  }
  if (/^\s*LOCK\s+TABLE\b/im.test(sql)) {
    await client.query("BEGIN");
    try {
      for (const statement of splitPostgresStatements(sql)) {
        await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    return;
  }
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
    } else if (char === "/" && next === "*") {
      current += next;
      index += 1;
      blockCommentDepth = 1;
    } else if (char === "'") {
      singleQuoted = true;
    } else if (char === '"') {
      doubleQuoted = true;
    } else if (char === "$") {
      const tag = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        current += tag.slice(1);
        index += tag.length - 1;
        dollarQuoteTag = tag;
      }
    } else if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
    }
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}
