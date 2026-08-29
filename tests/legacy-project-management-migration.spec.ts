// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { Prisma } from "@prisma/client";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { prisma } from "../lib/prisma";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma/migrations");
const SHRINK_MIGRATION_NAME =
  "20260728210000_remove_legacy_project_management";
const UNIFIED_ACCOUNT_SCHEMA_MIGRATION = "20260731120000_unified_account_schema";
const UNIFIED_ACCOUNT_BACKFILL_MIGRATION = "20260731121000_unified_account_backfill";
const UNIFIED_ACCOUNT_SCOPE_MIGRATION =
  "20260731122000_account_project_access_and_role_scope";
const PROCUREMENT_APPROVER_ACCOUNT_MIGRATION =
  "20260801100000_procurement_approver_accounts";
const LEGACY_TASK_SIGNATURE_COLUMNS = [
  "projectId",
  "stageId",
  "assigneeOpenId",
  "assigneeName",
  "dueAt",
  "isOverdue",
  "needsOfflineConfirmation",
  "needsWeeklyReport",
] as const;

test("收缩 migration 删除旧项目管理对象并保留共享数据模型", async () => {
  const oldTables = [
    "ProjectCreationRequest",
    "ProjectStage",
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
    "Project",
    "ProjectMember",
    "ProjectEstablishmentRequest",
    "ProjectEstablishmentRequestedTask",
  ];

  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (${Prisma.join([...oldTables, ...retainedTables])})
  `;
  const tableNames = tables.map((row) => row.table_name).sort();
  expect(tableNames).toEqual([...retainedTables].sort());

  const legacyTaskSignatureTables = await prisma.$queryRaw<
    Array<{ count: bigint }>
  >`
    SELECT COUNT(*) AS count
    FROM (
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Task'
        AND column_name IN (${Prisma.join(LEGACY_TASK_SIGNATURE_COLUMNS)})
      GROUP BY table_name
      HAVING COUNT(DISTINCT column_name) = ${LEGACY_TASK_SIGNATURE_COLUMNS.length}
    ) matched_legacy_task_tables
  `;
  expect(Number(legacyTaskSignatureTables[0]?.count ?? 0)).toBe(0);

  const abandonedPmTables = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'Pm%'
  `;
  expect(Number(abandonedPmTables[0]?.count ?? 0)).toBe(0);

  const projectColumns = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Project'
  `;
  const projectColumnNames = new Set(projectColumns.map((row) => row.column_name));
  expect(projectColumnNames).toContain("requesterAccountId");
  expect(projectColumnNames).toContain("establishmentRound");
  expect(projectColumnNames).not.toContain("ownerOpenId");
  expect(projectColumnNames).not.toContain("stageId");

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

test("统一账号 migration 映射旧角色、保留历史并且不发送通知", async () => {
  test.setTimeout(90_000);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(`拒绝在非测试数据库验证统一账号 migration: ${databaseName}`);
  }

  const temporaryDatabaseName = `ms_accounts_${process.pid}_${Date.now()}_test`;
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const temporaryDatabaseUrl = new URL(databaseUrl);
  temporaryDatabaseUrl.pathname = `/${temporaryDatabaseName}`;
  const adminClient = new Client({ connectionString: adminUrl.toString() });
  let migrationClient: Client | null = null;
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE "${temporaryDatabaseName}"`);
    migrationClient = new Client({ connectionString: temporaryDatabaseUrl.toString() });
    await migrationClient.connect();
    const migrationNames = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name < UNIFIED_ACCOUNT_SCHEMA_MIGRATION,
      )
      .map((entry) => entry.name)
      .sort();
    for (const migrationName of migrationNames) {
      await executeMigrationSql(
        migrationClient,
        await readFile(path.join(MIGRATIONS_DIR, migrationName, "migration.sql"), "utf8"),
      );
    }

    await migrationClient.query(`
      INSERT INTO "Account" (id, status, "createdAt", "updatedAt") VALUES
        ('account-super', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('account-project', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('account-leader', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "Person" (id, "accountId", "displayName", status, "createdAt", "updatedAt") VALUES
        ('person-super', 'account-super', '旧报销超管', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('person-project', 'account-project', '旧项目管理员', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('person-leader', 'account-leader', '旧车组管理员', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "AccountIdentity" (
        id, "accountId", provider, "providerSubject", "tenantId", "openId", "unionId", metadata, "createdAt", "updatedAt"
      ) VALUES
        ('identity-super', 'account-super', 'FEISHU', 'on-unified-super', 'default', 'ou-unified-super', 'on-unified-super', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('identity-project', 'account-project', 'FEISHU', 'on-unified-project', 'default', 'ou-unified-project', 'on-unified-project', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('identity-leader', 'account-leader', 'FEISHU', 'on-unified-leader', 'default', 'ou-unified-leader', 'on-unified-leader', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "User" (id, "openId", "unionId", name) VALUES
        ('user-super', 'ou-unified-super', 'on-unified-super', '旧报销超管'),
        ('user-project', 'ou-unified-project', 'on-unified-project', '旧项目管理员'),
        ('user-leader', 'ou-unified-leader', 'on-unified-leader', '旧车组管理员'),
        ('user-new-account', 'ou-unified-new', 'on-unified-new', '待创建统一账号');
      INSERT INTO "UserRole" (id, "openId", role, team, "techGroup") VALUES
        ('role-super', 'ou-unified-super', 'SUPER_ADMIN', '', ''),
        ('role-team', 'ou-unified-new', 'TEAM_ADMIN', '英雄', '');
      INSERT INTO "SystemRoleAssignment" (
        id, "accountId", role, team, "techGroup", "createdAt"
      ) VALUES
        ('role-system-admin', 'account-project', 'SYSTEM_ADMINISTRATOR', '', '', CURRENT_TIMESTAMP),
        ('role-team-admin', 'account-leader', 'TEAM_ADMINISTRATOR', '英雄', '', CURRENT_TIMESTAMP),
        ('role-resource-manager', 'account-leader', 'RESOURCE_MANAGER', '英雄', '', CURRENT_TIMESTAMP),
        ('role-auditor', 'account-project', 'AUDITOR', '', '', CURRENT_TIMESTAMP);
      INSERT INTO "PurchaseOrder" (
        id, "orderNo", "initiatorId", "initiatorName", team, "techGroup",
        "teamApproved", "techGroupApproved", "teamApproverOpenId",
        "techGroupApproverOpenId", "updatedAt"
      ) VALUES (
        'unified-approved-order', 'UNIFIED-APPROVER-BACKFILL', 'user-new-account',
        '待创建统一账号', '英雄', '电控', true, true,
        'ou-unified-super', 'ou-unified-project', CURRENT_TIMESTAMP
      );
    `);

    let firstBackfillAuditCount = 0;
    for (const migrationName of [
      UNIFIED_ACCOUNT_SCHEMA_MIGRATION,
      UNIFIED_ACCOUNT_BACKFILL_MIGRATION,
      UNIFIED_ACCOUNT_SCOPE_MIGRATION,
      PROCUREMENT_APPROVER_ACCOUNT_MIGRATION,
    ]) {
      const sql = await readFile(
        path.join(MIGRATIONS_DIR, migrationName, "migration.sql"),
        "utf8",
      );
      if (migrationName === UNIFIED_ACCOUNT_BACKFILL_MIGRATION) {
        await executeMigrationSqlInTransaction(migrationClient, sql);
        firstBackfillAuditCount = Number(
          (
            await migrationClient.query<{ count: string }>(`
              SELECT count(*)::text AS count
              FROM "DomainAuditEvent" WHERE source = 'MIGRATION'
            `)
          ).rows[0]?.count ?? 0,
        );
        await executeMigrationSqlInTransaction(migrationClient, sql);
        const repeatedAuditCount = Number(
          (
            await migrationClient.query<{ count: string }>(`
              SELECT count(*)::text AS count
              FROM "DomainAuditEvent" WHERE source = 'MIGRATION'
            `)
          ).rows[0]?.count ?? 0,
        );
        expect(repeatedAuditCount).toBe(firstBackfillAuditCount);
      } else {
        await executeMigrationSql(migrationClient, sql);
      }
    }

    const users = await migrationClient.query<{
      accountId: string | null;
      openId: string;
    }>(`SELECT "openId", "accountId" FROM "User" ORDER BY "openId"`);
    expect(users.rows.every((user) => Boolean(user.accountId))).toBe(true);
    expect(
      users.rows.find((user) => user.openId === "ou-unified-new")?.accountId,
    ).toBeTruthy();

    const activeRoles = await migrationClient.query<{
      role: string;
      team: string;
      techGroup: string;
    }>(`
      SELECT role::text AS role, team, "techGroup"
      FROM "SystemRoleAssignment"
      WHERE "revokedAt" IS NULL
      ORDER BY role::text, team, "techGroup"
    `);
    expect(activeRoles.rows).toEqual([
      { role: "GROUP_LEADER", team: "英雄", techGroup: "" },
      { role: "PROJECT_ADMINISTRATOR", team: "", techGroup: "" },
      { role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" },
    ]);

    const legacyRoles = await migrationClient.query<{
      role: string;
      revoked: boolean;
    }>(`
      SELECT role::text AS role, "revokedAt" IS NOT NULL AS revoked
      FROM "SystemRoleAssignment"
      WHERE role IN ('SYSTEM_ADMINISTRATOR', 'TEAM_ADMINISTRATOR', 'RESOURCE_MANAGER', 'AUDITOR')
      ORDER BY role::text
    `);
    expect(legacyRoles.rows).toEqual([
      { role: "AUDITOR", revoked: true },
      { role: "RESOURCE_MANAGER", revoked: true },
      { role: "SYSTEM_ADMINISTRATOR", revoked: true },
      { role: "TEAM_ADMINISTRATOR", revoked: true },
    ]);

    const reimbursementRoles = await migrationClient.query<{
      accountId: string | null;
      role: string;
      revoked: boolean;
    }>(`
      SELECT "accountId", role::text AS role, "revokedAt" IS NOT NULL AS revoked
      FROM "UserRole" ORDER BY role::text
    `);
    expect(reimbursementRoles.rows.every((role) => Boolean(role.accountId))).toBe(true);
    expect(reimbursementRoles.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "SUPER_ADMIN", revoked: true }),
        expect.objectContaining({ role: "TEAM_ADMIN", revoked: false }),
      ]),
    );

    const accountColumns = await migrationClient.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Account'
        AND column_name IN ('status', 'projectAccessStatus')
    `);
    expect(accountColumns.rows.map((row) => row.column_name)).toEqual([
      "projectAccessStatus",
    ]);
    const historicalApprovers = await migrationClient.query<{
      teamApproverAccountId: string | null;
      techGroupApproverAccountId: string | null;
    }>(`
      SELECT "teamApproverAccountId", "techGroupApproverAccountId"
      FROM "PurchaseOrder" WHERE id = 'unified-approved-order'
    `);
    expect(historicalApprovers.rows[0]).toEqual({
      teamApproverAccountId: "account-super",
      techGroupApproverAccountId: "account-project",
    });
    const sideEffects = await migrationClient.query<{
      audits: string;
      inApp: string;
      outbox: string;
    }>(`
      SELECT
        (SELECT count(*) FROM "DomainAuditEvent" WHERE source = 'MIGRATION')::text AS audits,
        (SELECT count(*) FROM "InAppNotification")::text AS "inApp",
        (SELECT count(*) FROM "NotificationOutbox")::text AS outbox
    `);
    expect(Number(sideEffects.rows[0]?.audits ?? 0)).toBeGreaterThanOrEqual(4);
    expect(sideEffects.rows[0]).toMatchObject({ inApp: "0", outbox: "0" });

    const retiredRoleAudits = await migrationClient.query<{ entityId: string }>(`
      SELECT "entityId"
      FROM "DomainAuditEvent"
      WHERE source = 'MIGRATION'
        AND action = 'account.legacy_role.revoked'
        AND "entityType" = 'SystemRoleAssignment'
      ORDER BY "entityId"
    `);
    expect(retiredRoleAudits.rows.map((row) => row.entityId)).toEqual([
      "role-auditor",
      "role-resource-manager",
      "role-system-admin",
      "role-team-admin",
    ]);
    await expect(
      migrationClient.query(`
        INSERT INTO "User" (id, "openId", name)
        VALUES ('invalid-orphan-user', 'ou-invalid-orphan', '非法孤儿用户')
      `),
    ).rejects.toThrow();

    await expect(
      migrationClient.query(`
        INSERT INTO "SystemRoleAssignment" (
          id, "accountId", role, team, "techGroup", "createdAt"
        ) VALUES (
          'invalid-active-legacy', 'account-project', 'AUDITOR', '', '', CURRENT_TIMESTAMP
        )
      `),
    ).rejects.toThrow();
    await expect(
      migrationClient.query(`
        INSERT INTO "UserRole" (
          id, "accountId", "openId", role, team, "techGroup", "createdAt"
        ) VALUES (
          'invalid-reimbursement-scope', 'account-project', 'ou-unified-project',
          'FINANCE', '', '', CURRENT_TIMESTAMP
        )
      `),
    ).rejects.toThrow();
  } finally {
    await migrationClient?.end().catch(() => undefined);
    await adminClient
      .query(`DROP DATABASE IF EXISTS "${temporaryDatabaseName}"`)
      .catch(() => undefined);
    await adminClient.end();
  }
});

test("统一账号 migration 对身份冲突和双范围旧组长失败关闭", async () => {
  test.setTimeout(90_000);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(`拒绝在非测试数据库验证统一账号预检: ${databaseName}`);
  }

  const temporaryDatabaseName = `ms_accounts_conflict_${process.pid}_${Date.now()}_test`;
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
          entry.isDirectory() && entry.name < UNIFIED_ACCOUNT_SCHEMA_MIGRATION,
      )
      .map((entry) => entry.name)
      .sort();
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
      INSERT INTO "Account" (id, status, "createdAt", "updatedAt") VALUES
        ('conflict-account-a', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('conflict-account-b', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "AccountIdentity" (
        id, "accountId", provider, "providerSubject", "tenantId", "openId", "unionId", metadata, "createdAt", "updatedAt"
      ) VALUES
        ('conflict-identity-union', 'conflict-account-a', 'FEISHU', 'on-conflict', 'default', NULL, 'on-conflict', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ('conflict-identity-open', 'conflict-account-b', 'FEISHU', 'open:ou-conflict', 'default', 'ou-conflict', NULL, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO "User" (id, "openId", "unionId", name)
      VALUES ('conflict-user', 'ou-conflict', 'on-conflict', '冲突用户');
      INSERT INTO "UserRole" (id, "openId", role, team, "techGroup")
      VALUES ('conflict-super-role', 'ou-conflict', 'SUPER_ADMIN', '', '');
    `);
    await executeMigrationSql(
      migrationClient,
      await readFile(
        path.join(
          MIGRATIONS_DIR,
          UNIFIED_ACCOUNT_SCHEMA_MIGRATION,
          "migration.sql",
        ),
        "utf8",
      ),
    );
    const backfillSql = await readFile(
      path.join(
        MIGRATIONS_DIR,
        UNIFIED_ACCOUNT_BACKFILL_MIGRATION,
        "migration.sql",
      ),
      "utf8",
    );
    await expect(
      executeMigrationSqlInTransaction(migrationClient, backfillSql),
    ).rejects.toThrow("飞书身份关联了多个 Account");

    await migrationClient.query(`
      UPDATE "AccountIdentity"
      SET "accountId" = 'conflict-account-a'
      WHERE id = 'conflict-identity-open';
    `);
    const preflight = spawnSync(
      path.join(process.cwd(), "node_modules", ".bin", "tsx"),
      ["scripts/preflight-unified-accounts.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: temporaryDatabaseUrl.toString(),
        },
      },
    );
    expect(preflight.status).toBe(1);
    expect(JSON.parse(preflight.stdout)).toMatchObject({
      identityConflicts: 1,
      ready: false,
    });
    await expect(
      executeMigrationSqlInTransaction(migrationClient, backfillSql),
    ).rejects.toThrow("同一飞书用户命中多个 AccountIdentity");

    await migrationClient.query(`
      DELETE FROM "AccountIdentity" WHERE id = 'conflict-identity-open';
      INSERT INTO "SystemRoleAssignment" (
        id, "accountId", role, team, "techGroup", "createdAt"
      ) VALUES (
        'ambiguous-team-administrator', 'conflict-account-a',
        'TEAM_ADMINISTRATOR', '英雄', '电控', CURRENT_TIMESTAMP
      );
    `);
    await expect(
      executeMigrationSqlInTransaction(migrationClient, backfillSql),
    ).rejects.toThrow("同时包含车组和技术组");
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

async function executeMigrationSqlInTransaction(client: Client, sql: string) {
  await client.query("BEGIN");
  try {
    for (const statement of splitPostgresStatements(sql)) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
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
