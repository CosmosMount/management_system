import { expect, test } from "@playwright/test";
import { Prisma } from "@prisma/client";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { prisma } from "../lib/prisma";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma/migrations");
const SHRINK_MIGRATION_NAME =
  "20260728210000_remove_legacy_project_management";

test("收缩 migration 删除旧项目管理对象并保留共享数据模型", async () => {
  const oldTables = [
    "Project",
    "ProjectCreationRequest",
    "ProjectStage",
    "Task",
    "TaskSubmission",
    "WeeklyReport",
    "ApprovalRecord",
    "ProgressReminderRule",
    "ProgressDailySummarySetting",
  ];
  const retainedTables = [
    "User",
    "UserRole",
    "PurchaseOrder",
    "Feedback",
    "FileAsset",
    "ProcurementFeishuCard",
    "NotificationOutbox",
    "NotificationOutboxRecipient",
  ];

  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (${Prisma.join([...oldTables, ...retainedTables])})
  `;
  const tableNames = tables.map((row) => row.table_name).sort();
  expect(tableNames).toEqual([...retainedTables].sort());

  const abandonedPmTables = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'Pm%'
  `;
  expect(Number(abandonedPmTables[0]?.count ?? 0)).toBe(0);

  const roleValues = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT enumlabel
    FROM pg_enum
    JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
    WHERE pg_type.typname = 'UserRoleType'
    ORDER BY pg_enum.enumsortorder
  `;
  expect(roleValues.map((row) => row.enumlabel)).toEqual([
    "SUPER_ADMIN",
    "TEAM_ADMIN",
    "TECH_GROUP_ADMIN",
    "TEACHER",
    "FINANCE",
  ]);

  expect(
    await prisma.notificationOutbox.count({ where: { channel: "progress" } }),
  ).toBe(0);
});

test("收缩 migration 基于真实前置迁移链删除旧数据并保留共享记录", async () => {
  test.setTimeout(60_000);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(`拒绝在非测试数据库验证破坏性 migration: ${databaseName}`);
  }

  const temporaryDatabaseName = `ms_legacy_${process.pid}_${Date.now()}_test`;
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const temporaryDatabaseUrl = new URL(databaseUrl);
  temporaryDatabaseUrl.pathname = `/${temporaryDatabaseName}`;
  const adminClient = new Client({ connectionString: adminUrl.toString() });
  let migrationClient: Client | null = null;
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE "${temporaryDatabaseName}"`);
    migrationClient = new Client({
      connectionString: temporaryDatabaseUrl.toString(),
    });
    await migrationClient.connect();
    const migrationNames = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name < SHRINK_MIGRATION_NAME,
      )
      .map((entry) => entry.name)
      .sort();
    expect(migrationNames.length).toBeGreaterThan(0);
    for (const migrationName of migrationNames) {
      await executeMigrationSql(
        migrationClient,
        await readFile(
          path.join(MIGRATIONS_DIR, migrationName, "migration.sql"),
          "utf8",
        ),
      );
    }
    await migrationClient.query(`
      INSERT INTO "User" ("id", "openId", "unionId", "name")
      VALUES ('shared-user', 'ou_shared', 'on_shared', '保留用户');
      INSERT INTO "UserRole" ("id", "openId", "role") VALUES
        ('retained-role', 'ou_shared', 'FINANCE'),
        ('removed-role', 'ou_shared', 'PROJECT_MANAGER');
      INSERT INTO "PurchaseOrder" (
        "id", "orderNo", "initiatorId", "initiatorName", "team",
        "techGroup", "updatedAt"
      ) VALUES (
        'shared-order', 'MIGRATION-KEEP-ORDER', 'shared-user', '保留用户',
        '英雄', '电控', CURRENT_TIMESTAMP
      );
      INSERT INTO "Feedback" (
        "id", "submitterOpenId", "submitterName", "updatedAt"
      ) VALUES ('shared-feedback', 'ou_shared', '保留用户', CURRENT_TIMESTAMP);
      INSERT INTO "FileAsset" (
        "id", "publicPath", "storagePath", "kind", "mimeType", "size",
        "ownerOpenId"
      ) VALUES (
        'shared-asset', '/uploads/migration-keep', 'migration-keep',
        'ORDER_ATTACHMENT', 'text/plain', 4, 'ou_shared'
      );
      INSERT INTO "ProcurementFeishuCard" (
        "id", "orderId", "openId", "cardId", "botKind", "cardStage",
        "updatedAt"
      ) VALUES (
        'shared-card', 'shared-order', 'ou_shared', 'card-keep',
        'notification', 'COMPLETED', CURRENT_TIMESTAMP
      );
      INSERT INTO "NotificationOutbox" (
        "id", "eventKey", "channel", "type", "payload", "updatedAt"
      ) VALUES
        (
          'progress-outbox', 'migration-progress-remove', 'progress',
          'legacy', '{}', CURRENT_TIMESTAMP
        ),
        (
          'procurement-outbox', 'migration-procurement-keep', 'procurement',
          'order', '{}', CURRENT_TIMESTAMP
        );
      INSERT INTO "NotificationOutboxRecipient" (
        "id", "outboxId", "openId", "updatedAt"
      ) VALUES
        ('progress-recipient', 'progress-outbox', 'ou_shared', CURRENT_TIMESTAMP),
        (
          'procurement-recipient', 'procurement-outbox', 'ou_shared',
          CURRENT_TIMESTAMP
        );
      INSERT INTO "Project" (
        "id", "name", "team", "techGroup", "ownerOpenId", "ownerName",
        "updatedAt"
      ) VALUES (
        'legacy-project', '待删除项目', '英雄', '电控', 'ou_shared',
        '保留用户', CURRENT_TIMESTAMP
      );
      INSERT INTO "Task" (
        "id", "projectId", "title", "assigneeOpenId", "assigneeName",
        "team", "techGroup", "dueAt", "updatedAt"
      ) VALUES (
        'legacy-task', 'legacy-project', '待删除任务', 'ou_shared', '保留用户',
        '英雄', '电控', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);

    await executeMigrationSql(
      migrationClient,
      await readFile(
        path.join(MIGRATIONS_DIR, SHRINK_MIGRATION_NAME, "migration.sql"),
        "utf8",
      ),
    );

    const removedTables = await migrationClient.query<{ name: string | null }>(`
      SELECT to_regclass('public."Project"')::text AS name
      UNION ALL SELECT to_regclass('public."Task"')::text
      UNION ALL SELECT to_regclass('public."ProjectStage"')::text
      UNION ALL SELECT to_regclass('public."ApprovalRecord"')::text
    `);
    expect(removedTables.rows.every((row) => row.name === null)).toBe(true);

    const retainedIds = await migrationClient.query<{ id: string }>(`
      SELECT "id" FROM "User" WHERE "id" = 'shared-user'
      UNION ALL SELECT "id" FROM "PurchaseOrder" WHERE "id" = 'shared-order'
      UNION ALL SELECT "id" FROM "Feedback" WHERE "id" = 'shared-feedback'
      UNION ALL SELECT "id" FROM "FileAsset" WHERE "id" = 'shared-asset'
      UNION ALL SELECT "id" FROM "ProcurementFeishuCard" WHERE "id" = 'shared-card'
      UNION ALL SELECT "id" FROM "NotificationOutbox"
        WHERE "id" = 'procurement-outbox'
      UNION ALL SELECT "id" FROM "NotificationOutboxRecipient"
        WHERE "id" = 'procurement-recipient'
      ORDER BY "id"
    `);
    expect(retainedIds.rows.map((row) => row.id)).toEqual([
      "procurement-outbox",
      "procurement-recipient",
      "shared-asset",
      "shared-card",
      "shared-feedback",
      "shared-order",
      "shared-user",
    ]);

    const removedProgressRows = await migrationClient.query<{ count: string }>(`
      SELECT
        (SELECT COUNT(*) FROM "NotificationOutbox"
          WHERE "id" = 'progress-outbox') +
        (SELECT COUNT(*) FROM "NotificationOutboxRecipient"
          WHERE "id" = 'progress-recipient') AS count
    `);
    expect(Number(removedProgressRows.rows[0]?.count ?? 0)).toBe(0);

    const roles = await migrationClient.query<{ role: string }>(
      `SELECT "role"::text AS role FROM "UserRole" ORDER BY "role"::text`,
    );
    expect(roles.rows.map((row) => row.role)).toEqual(["FINANCE"]);
    const enumValues = await migrationClient.query<{ enumlabel: string }>(`
      SELECT enumlabel
      FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
      WHERE pg_type.typname = 'UserRoleType'
      ORDER BY pg_enum.enumsortorder
    `);
    expect(enumValues.rows.map((row) => row.enumlabel)).toEqual([
      "SUPER_ADMIN",
      "TEAM_ADMIN",
      "TECH_GROUP_ADMIN",
      "TEACHER",
      "FINANCE",
    ]);
    const removedEnums = await migrationClient.query<{ count: string }>(`
      SELECT COUNT(*) AS count
      FROM pg_type
      WHERE pg_type.typname IN (
        'ProjectStatus', 'TaskStatus', 'ApprovalDecision', 'StageStatus'
      )
    `);
    expect(Number(removedEnums.rows[0]?.count ?? 0)).toBe(0);
  } finally {
    await migrationClient?.end().catch(() => undefined);
    await adminClient
      .query(`DROP DATABASE IF EXISTS "${temporaryDatabaseName}"`)
      .catch(() => undefined);
    await adminClient.end();
  }
});

async function executeMigrationSql(client: Client, sql: string) {
  for (const statement of splitPostgresStatements(sql)) {
    await client.query(statement);
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
