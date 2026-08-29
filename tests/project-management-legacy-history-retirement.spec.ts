// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "pg";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma/migrations");
const RETIREMENT_MIGRATION =
  "20260814120000_retire_project_management_legacy_history";

test("legacy history retirement archives old values, blocks active roles and reaches final schema without notifications", async () => {
  test.setTimeout(300_000);
  const sourceUrl = localTestDatabaseUrl();
  const sourceDatabaseName = sourceUrl.pathname.replace(/^\//, "");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `${sourceDatabaseName.slice(0, 18)}_${suffix}_pm_history_test`;
  if (!/^[A-Za-z0-9_]+_pm_history_test$/.test(databaseName)) {
    throw new Error("项目管理历史退役临时数据库名称安全校验失败");
  }

  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let target: Client | null = null;
  let writer: Client | null = null;
  let observer: Client | null = null;
  let temporaryPrismaRoot: string | null = null;
  let activeDeploy: ReturnType<typeof startControlledDeploy> | null = null;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    temporaryPrismaRoot = await createPreRetirementMigrationConfig();
    const predecessorDeploy = runPrismaDeploy(
      targetUrl,
      path.join(temporaryPrismaRoot, "prisma.config.ts"),
    );
    expect(
      predecessorDeploy.status,
      commandOutput(predecessorDeploy),
    ).toBe(0);

    target = new Client({ connectionString: targetUrl.toString() });
    writer = new Client({ connectionString: targetUrl.toString() });
    observer = new Client({ connectionString: targetUrl.toString() });
    await target.connect();
    await writer.connect();
    await observer.connect();

    const ids = await seedLegacyHistory(target);
    const migrationSql = await readFile(
      path.join(MIGRATIONS_DIR, RETIREMENT_MIGRATION, "migration.sql"),
      "utf8",
    );
    const notificationBaseline = await notificationCounts(target);
    const notificationSnapshotBaseline = await notificationSnapshot(target);

    await expect(executeMigrationSql(target, migrationSql)).rejects.toThrow(
      /active_legacy_system_roles=1 active_legacy_task_roles=1/,
    );
    expect(await notificationCounts(target)).toEqual(notificationBaseline);
    expect(await notificationSnapshot(target)).toEqual(
      notificationSnapshotBaseline,
    );
    expect(await auditCount(target, "migration:pm-history:v1:%")).toBe(0);
    expect(await columnExists(target, "WorkSegment", "completionPercent")).toBe(
      true,
    );

    await target.query(
      `UPDATE "SystemRoleAssignment" SET "revokedAt" = $2 WHERE id = $1`,
      [ids.activeLegacySystemRole, ids.retiredAt],
    );
    await target.query(
      `UPDATE "TaskMember" SET "removedAt" = $2 WHERE id = $1`,
      [ids.activeLegacyTaskMember, ids.retiredAt],
    );

    const sourceCounts = await legacySourceCounts(target);
    expect(sourceCounts).toEqual({
      completion: 3,
      systemRoles: 6,
      taskRoles: 5,
    });

    const targetBackendPid = Number(
      (await target.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`))
        .rows[0]?.pid,
    );
    await target.query("BEGIN");
    await target.query(
      `LOCK TABLE "DomainAuditEvent" IN ACCESS EXCLUSIVE MODE`,
    );
    await writer.query("BEGIN");
    await writer.query(
      `UPDATE "WorkSegment" SET "completionPercent" = 62.50 WHERE id = $1`,
      [ids.segment],
    );
    activeDeploy = startControlledDeploy(targetUrl);
    await waitForRetirementMigrationLock(observer);
    let deployCompleted = false;
    void activeDeploy.completion.then(() => {
      deployCompleted = true;
    });
    expect(deployCompleted).toBe(false);
    await writer.query("COMMIT");
    await waitForRetirementMigrationBlockedBy(observer, targetBackendPid);

    const concurrentNotificationIds = {
      inApp: randomUUID(),
      outbox: randomUUID(),
      recipient: randomUUID(),
    };
    await observer.query(
      `INSERT INTO "InAppNotification" (
         id, "eventKey", "recipientAccountId", category, title,
         "entityType", "entityId"
       ) VALUES ($1, $2, $3, 'TASK', '迁移期间无关通知', 'Task', $4)`,
      [
        concurrentNotificationIds.inApp,
        `concurrent:${concurrentNotificationIds.inApp}`,
        ids.account,
        ids.task,
      ],
    );
    await observer.query(
      `INSERT INTO "NotificationOutbox" (
         id, "eventKey", channel, type, payload, "updatedAt"
       ) VALUES ($1, $2, 'project-management', 'concurrent_event', '{}', CURRENT_TIMESTAMP)`,
      [
        concurrentNotificationIds.outbox,
        `concurrent:${concurrentNotificationIds.outbox}`,
      ],
    );
    await observer.query(
      `INSERT INTO "NotificationOutboxRecipient" (
         id, "outboxId", "openId", "updatedAt"
       ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [
        concurrentNotificationIds.recipient,
        concurrentNotificationIds.outbox,
        `ou_${concurrentNotificationIds.recipient}`,
      ],
    );
    const notificationCountsAfterConcurrentWrite =
      await notificationCounts(observer);
    expect(notificationCountsAfterConcurrentWrite).toEqual({
      inApp: String(Number(notificationBaseline.inApp) + 1),
      outbox: String(Number(notificationBaseline.outbox) + 1),
      recipients: String(Number(notificationBaseline.recipients) + 1),
    });
    const notificationSnapshotAfterConcurrentWrite =
      await notificationSnapshot(observer);
    await target.query("COMMIT");
    const successfulDeploy = await activeDeploy.completion;
    expect(successfulDeploy.status, commandOutput(successfulDeploy)).toBe(0);
    activeDeploy = null;

    expect(await enumValues(target, "ProjectManagementSystemRole")).toEqual([
      "SUPER_ADMINISTRATOR",
      "PROJECT_ADMINISTRATOR",
    ]);
    expect(await enumValues(target, "TaskMemberRole")).toEqual([
      "OWNER",
      "PARTICIPANT",
    ]);
    expect(await columnExists(target, "WorkSegment", "completionPercent")).toBe(
      false,
    );
    expect(await notificationCounts(target)).toEqual(
      notificationCountsAfterConcurrentWrite,
    );
    expect(await notificationSnapshot(target)).toEqual(
      notificationSnapshotAfterConcurrentWrite,
    );
    expect(
      await rowsByIds(target, "SystemRoleAssignment", [
        ...Object.values(ids.retiredLegacySystemRoles),
        ids.activeLegacySystemRole,
      ]),
    ).toEqual([]);
    expect(
      await rowsByIds(target, "TaskMember", [
        ...Object.values(ids.retiredLegacyTaskMembers),
        ids.activeLegacyTaskMember,
      ]),
    ).toEqual([]);

    const systemAudits = await target.query<{
      id: string;
      entityId: string;
      before: Record<string, unknown>;
      source: string;
      createdAt: Date;
    }>(
      `SELECT id, "entityId", before, source::TEXT, "createdAt"
       FROM "DomainAuditEvent"
       WHERE action = 'account.legacy_project_role.archived'
       ORDER BY id`,
    );
    expect(systemAudits.rows).toHaveLength(sourceCounts.systemRoles);
    expect(
      systemAudits.rows.map((event) => event.before.role).sort(),
    ).toEqual(
      [
        "SYSTEM_ADMINISTRATOR",
        "TEAM_ADMINISTRATOR",
        "RESOURCE_MANAGER",
        "AUDITOR",
        "GROUP_LEADER",
        "AUDITOR",
      ].sort(),
    );
    expect(systemAudits.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `migration:pm-history:v1:system-role:${ids.retiredLegacySystemRoles.groupLeader}`,
          entityId: ids.account,
          source: "MIGRATION",
          before: expect.objectContaining({
            assignmentId: ids.retiredLegacySystemRoles.groupLeader,
            accountId: ids.account,
            role: "GROUP_LEADER",
            team: "英雄",
            techGroup: "",
          }),
        }),
      ]),
    );
    const retiredSystemAudit = systemAudits.rows.find(
      (event) =>
        event.id ===
        `migration:pm-history:v1:system-role:${ids.retiredLegacySystemRoles.groupLeader}`,
    );
    expect(new Date(String(retiredSystemAudit?.before.createdAt)).toISOString()).toBe(
      ids.createdAt,
    );
    expect(new Date(String(retiredSystemAudit?.before.revokedAt)).toISOString()).toBe(
      ids.retiredAt,
    );

    const taskAudits = await target.query<{
      id: string;
      taskId: string;
      before: Record<string, unknown>;
    }>(
      `SELECT id, "taskId", before
       FROM "DomainAuditEvent"
       WHERE action = 'pm.task.legacy_member_role.archived'
       ORDER BY id`,
    );
    expect(taskAudits.rows).toHaveLength(sourceCounts.taskRoles);
    expect(taskAudits.rows.map((event) => event.before.role).sort()).toEqual(
      ["LEAD", "MEMBER", "REVIEWER", "VIEWER", "VIEWER"].sort(),
    );
    expect(taskAudits.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `migration:pm-history:v1:task-member:${ids.retiredLegacyTaskMembers.lead}`,
          taskId: ids.task,
          before: expect.objectContaining({
            personId: ids.person,
            role: "LEAD",
          }),
        }),
      ]),
    );
    const retiredTaskAudit = taskAudits.rows.find(
      (event) =>
        event.id ===
        `migration:pm-history:v1:task-member:${ids.retiredLegacyTaskMembers.lead}`,
    );
    expect(new Date(String(retiredTaskAudit?.before.createdAt)).toISOString()).toBe(
      ids.createdAt,
    );
    expect(new Date(String(retiredTaskAudit?.before.removedAt)).toISOString()).toBe(
      ids.retiredAt,
    );

    const completionAudits = await target.query<{
      id: string;
      entityId: string;
      taskId: string | null;
      before: Record<string, unknown>;
    }>(
      `SELECT id, "entityId", "taskId", before
       FROM "DomainAuditEvent"
       WHERE action = 'pm.segment.legacy_completion_percent.archived'
       ORDER BY id`,
    );
    expect(completionAudits.rows).toHaveLength(sourceCounts.completion);
    expect(completionAudits.rows).toEqual(
      expect.arrayContaining([
        {
          id: `migration:pm-history:v1:segment-completion:${ids.segment}`,
          entityId: ids.segment,
          taskId: ids.task,
          before: expect.objectContaining({
            taskId: ids.task,
            personId: ids.person,
            completionPercent: 62.5,
            type: "ACTUAL",
            status: "CONFIRMED",
          }),
        },
        {
          id: `migration:pm-history:v1:segment-completion:${ids.zeroSegment}`,
          entityId: ids.zeroSegment,
          taskId: ids.task,
          before: expect.objectContaining({
            taskId: ids.task,
            personId: ids.person,
            completionPercent: 0,
          }),
        },
        {
          id: `migration:pm-history:v1:segment-completion:${ids.fullUnlinkedSegment}`,
          entityId: ids.fullUnlinkedSegment,
          taskId: null,
          before: expect.objectContaining({
            taskId: null,
            personId: ids.person,
            completionPercent: 100,
          }),
        },
      ]),
    );
    expect(
      completionAudits.rows.some(
        (event) =>
          event.id ===
          `migration:pm-history:v1:segment-completion:${ids.nullCompletionSegment}`,
      ),
    ).toBe(false);
    const updatedCompletionAudit = completionAudits.rows.find(
      (event) =>
        event.id ===
        `migration:pm-history:v1:segment-completion:${ids.segment}`,
    );
    expect(
      new Date(String(updatedCompletionAudit?.before.createdAt)).toISOString(),
    ).toBe(ids.createdAt);

    await expect(
      target.query(
        `UPDATE "DomainAuditEvent" SET reason = '不可修改'
         WHERE id = $1`,
        [`migration:pm-history:v1:segment-completion:${ids.segment}`],
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      target.query(
        `DELETE FROM "DomainAuditEvent" WHERE id = $1`,
        [`migration:pm-history:v1:segment-completion:${ids.segment}`],
      ),
    ).rejects.toThrow(/append-only/i);

    const taskAccessPreflight = runTsxScript(
      targetUrl,
      "scripts/preflight-task-access-migration.ts",
    );
    expect(
      taskAccessPreflight.status,
      commandOutput(taskAccessPreflight),
    ).toBe(0);
    expect(JSON.parse(taskAccessPreflight.stdout)).toMatchObject({
      activeGroupLeaderAssignments: 0,
      ready: true,
    });
    const accountPreflight = runTsxScript(
      targetUrl,
      "scripts/preflight-unified-accounts.ts",
    );
    expect(accountPreflight.status, commandOutput(accountPreflight)).toBe(0);
    expect(JSON.parse(accountPreflight.stdout)).toMatchObject({ ready: true });

    const historicalOpenId = `ou_history_${randomUUID()}`;
    await target.query(
      `UPDATE "AccountIdentity" SET "openId" = $2 WHERE "accountId" = $1`,
      [ids.account, `ou_rotated_${randomUUID()}`],
    );
    await target.query(
      `UPDATE "User"
       SET "openId" = (
         SELECT "openId" FROM "AccountIdentity"
         WHERE "accountId" = $1 AND provider = 'FEISHU' AND "tenantId" = 'default'
       )
       WHERE "accountId" = $1`,
      [ids.account],
    );
    await target.query(
      `INSERT INTO "UserRole" (
         id, "accountId", "openId", role, team, "techGroup", "revokedAt", "createdAt"
       ) VALUES
         ($1, $3, $4, 'FINANCE', '工程', '', $5, $5),
         ($2, $3, $4, 'FINANCE', '工程', '', NULL, CURRENT_TIMESTAMP)`,
      [randomUUID(), randomUUID(), ids.account, historicalOpenId, ids.retiredAt],
    );
    const currentHeadHistoricalRolePreflight = runTsxScript(
      targetUrl,
      "scripts/preflight-unified-accounts.ts",
    );
    expect(
      currentHeadHistoricalRolePreflight.status,
      commandOutput(currentHeadHistoricalRolePreflight),
    ).toBe(0);
    expect(JSON.parse(currentHeadHistoricalRolePreflight.stdout)).toMatchObject({
      duplicateReimbursementRoles: 0,
      orphanRoles: 0,
      ready: true,
    });

    const auditCountAfterFirstRun = await auditCount(
      target,
      "migration:pm-history:v1:%",
    );
    const idempotentDeploy = runControlledDeploy(targetUrl);
    expect(idempotentDeploy.status, commandOutput(idempotentDeploy)).toBe(0);
    expect(commandOutput(idempotentDeploy)).toContain(
      "No pending migrations to apply",
    );
    expect(await auditCount(target, "migration:pm-history:v1:%")).toBe(
      auditCountAfterFirstRun,
    );
    expect(await notificationCounts(target)).toEqual(
      notificationCountsAfterConcurrentWrite,
    );
    expect(await notificationSnapshot(target)).toEqual(
      notificationSnapshotAfterConcurrentWrite,
    );
    expect(await auditGuardNames(target)).toEqual([
      "DomainAuditEvent_prevent_delete",
      "DomainAuditEvent_prevent_update",
    ]);

    const drift = spawnSync(
      "npx",
      [
        "prisma",
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: targetUrl.toString() },
        encoding: "utf8",
      },
    );
    expect(
      drift.status,
      `schema drift:\n${drift.stdout}\n${drift.stderr}`,
    ).toBe(0);
  } finally {
    if (activeDeploy) {
      activeDeploy.child.kill("SIGTERM");
      await activeDeploy.completion.catch(() => undefined);
    }
    await writer?.query("ROLLBACK").catch(() => undefined);
    await writer?.end().catch(() => undefined);
    await observer?.end().catch(() => undefined);
    await target?.query("ROLLBACK").catch(() => undefined);
    if (target) await target.end().catch(() => undefined);
    if (temporaryPrismaRoot) {
      await rm(temporaryPrismaRoot, { force: true, recursive: true });
    }
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

function localTestDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const url = new URL(raw);
  const databaseName = url.pathname.replace(/^\//, "");
  if (
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    !databaseName.endsWith("_test") ||
    /prod(?:uction)?/i.test(databaseName)
  ) {
    throw new Error("拒绝在非本机测试数据库执行项目管理历史退役 migration 回归");
  }
  return url;
}

async function createPreRetirementMigrationConfig() {
  const temporaryRootParent = path.join(process.cwd(), ".tmp");
  await mkdir(temporaryRootParent, { recursive: true });
  const temporaryRoot = await mkdtemp(
    path.join(temporaryRootParent, "pm-history-retirement-"),
  );
  const temporaryMigrations = path.join(temporaryRoot, "migrations");
  await mkdir(temporaryMigrations);
  const migrationNames = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && entry.name < RETIREMENT_MIGRATION,
    )
    .map((entry) => entry.name)
    .sort();
  expect(migrationNames.length).toBeGreaterThan(0);
  for (const migrationName of migrationNames) {
    await cp(
      path.join(MIGRATIONS_DIR, migrationName),
      path.join(temporaryMigrations, migrationName),
      { recursive: true },
    );
  }
  const configPath = path.join(temporaryRoot, "prisma.config.ts");
  await writeFile(
    configPath,
    `import { defineConfig } from "prisma/config";\n` +
      `export default defineConfig({\n` +
      `  schema: ${JSON.stringify(path.join(process.cwd(), "prisma/schema.prisma"))},\n` +
      `  migrations: { path: ${JSON.stringify(temporaryMigrations)} },\n` +
      `  datasource: { url: process.env.DATABASE_URL },\n` +
      `});\n`,
    "utf8",
  );
  return temporaryRoot;
}

async function seedLegacyHistory(client: Client) {
  const ids = {
    account: randomUUID(),
    user: randomUUID(),
    person: randomUUID(),
    activeLegacyPerson: randomUUID(),
    plan: randomUUID(),
    task: randomUUID(),
    ownerMember: randomUUID(),
    retiredLegacySystemRoles: {
      systemAdministrator: randomUUID(),
      teamAdministrator: randomUUID(),
      resourceManager: randomUUID(),
      auditor: randomUUID(),
      groupLeader: randomUUID(),
    },
    activeLegacySystemRole: randomUUID(),
    retiredLegacyTaskMembers: {
      lead: randomUUID(),
      member: randomUUID(),
      reviewer: randomUUID(),
      viewer: randomUUID(),
    },
    activeLegacyTaskMember: randomUUID(),
    segment: randomUUID(),
    zeroSegment: randomUUID(),
    fullUnlinkedSegment: randomUUID(),
    nullCompletionSegment: randomUUID(),
    inApp: randomUUID(),
    outbox: randomUUID(),
    recipient: randomUUID(),
    createdAt: "2026-01-02T03:04:05.000Z",
    retiredAt: "2026-02-03T04:05:06.000Z",
  };

  await client.query("BEGIN");
  try {
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO "Account" (id, "updatedAt") VALUES ($1, CURRENT_TIMESTAMP)`,
      [ids.account],
    );
    await client.query(
      `INSERT INTO "Person" (
         id, "accountId", "displayName", status, "createdAt", "updatedAt"
       ) VALUES
         ($1, $3, '历史归档测试人员', 'ACTIVE', $4, CURRENT_TIMESTAMP),
         ($2, NULL, '活跃旧角色阻断人员', 'ACTIVE', $4, CURRENT_TIMESTAMP)`,
      [ids.person, ids.activeLegacyPerson, ids.account, ids.createdAt],
    );
    await client.query(
      `INSERT INTO "AccountIdentity" (
         id, "accountId", provider, "providerSubject", "tenantId", "openId",
         metadata, "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, 'FEISHU', $3, 'default', $4, '{}', $5, CURRENT_TIMESTAMP
       )`,
      [randomUUID(), ids.account, `open:${ids.account}`, `ou_${ids.account}`, ids.createdAt],
    );
    await client.query(
      `INSERT INTO "User" (
         id, "accountId", "openId", name, "createdAt"
       ) VALUES ($1, $2, $3, '历史归档报销用户', $4)`,
      [ids.user, ids.account, `ou_${ids.account}`, ids.createdAt],
    );
    await client.query(
      `INSERT INTO "SystemRoleAssignment" (
         id, "accountId", role, team, "techGroup", "revokedAt", "createdAt"
       ) VALUES
         ($1, $7, 'SUPER_ADMINISTRATOR', '', '', NULL, $9),
         ($2, $7, 'SYSTEM_ADMINISTRATOR', '', '', $8, $9),
         ($3, $7, 'TEAM_ADMINISTRATOR', '英雄', '', $8, $9),
         ($4, $7, 'RESOURCE_MANAGER', '', '机械', $8, $9),
         ($5, $7, 'AUDITOR', '', '', $8, $9),
         ($6, $7, 'GROUP_LEADER', '英雄', '', $8, $9)`,
      [
        randomUUID(),
        ids.retiredLegacySystemRoles.systemAdministrator,
        ids.retiredLegacySystemRoles.teamAdministrator,
        ids.retiredLegacySystemRoles.resourceManager,
        ids.retiredLegacySystemRoles.auditor,
        ids.retiredLegacySystemRoles.groupLeader,
        ids.account,
        ids.retiredAt,
        ids.createdAt,
      ],
    );
    await client.query(
      `INSERT INTO "Task" (
         id, title, status, "currentPlanVersionId", "createdByAccountId", "createdAt", "updatedAt"
       ) VALUES ($1, '历史归档 Task', 'COMPLETED', $2, $3, $4, CURRENT_TIMESTAMP)`,
      [ids.task, ids.plan, ids.account, ids.createdAt],
    );
    await client.query(
      `INSERT INTO "TaskPlanVersion" (
         id, "taskId", "versionNo", status, "createdByAccountId", "createdAt", "updatedAt"
       ) VALUES ($1, $2, 1, 'CURRENT', $3, $4, CURRENT_TIMESTAMP)`,
      [ids.plan, ids.task, ids.account, ids.createdAt],
    );
    await client.query(
      `INSERT INTO "TaskMember" (
         id, "taskId", "personId", role, "createdByAccountId", "removedAt", "createdAt"
       ) VALUES
         ($1, $2, $3, 'OWNER', $4, NULL, $9),
         ($5, $2, $3, 'LEAD', $4, $10, $9),
         ($6, $2, $3, 'MEMBER', $4, $10, $9),
         ($7, $2, $3, 'REVIEWER', $4, $10, $9),
         ($8, $2, $3, 'VIEWER', $4, $10, $9)`,
      [
        ids.ownerMember,
        ids.task,
        ids.person,
        ids.account,
        ids.retiredLegacyTaskMembers.lead,
        ids.retiredLegacyTaskMembers.member,
        ids.retiredLegacyTaskMembers.reviewer,
        ids.retiredLegacyTaskMembers.viewer,
        ids.createdAt,
        ids.retiredAt,
      ],
    );
    await client.query(
      `INSERT INTO "WorkSegment" (
         id, "personId", type, status, "startAt", "endAt", content,
         priority, "expectedOutput", "actualOutput", "completionPercent",
         "taskId", "createdByAccountId", "createdAt", "updatedAt"
       ) VALUES
         ($1, $5, 'ACTUAL', 'CONFIRMED',
          '2026-01-02T04:00:00Z', '2026-01-02T05:00:00Z', '历史完成比例',
          'MEDIUM', '', '完成', 37.50, $6, $7, $8, CURRENT_TIMESTAMP),
         ($2, $5, 'PLANNED', 'PLANNED',
          '2026-01-02T05:00:00Z', '2026-01-02T06:00:00Z', '零完成比例',
          'MEDIUM', '计划', '', 0, $6, $7, $8, CURRENT_TIMESTAMP),
         ($3, $5, 'ACTUAL', 'CONFIRMED',
          '2026-01-02T06:00:00Z', '2026-01-02T07:00:00Z', '无 Task 完成比例',
          'MEDIUM', '', '完成', 100, NULL, $7, $8, CURRENT_TIMESTAMP),
         ($4, $5, 'ACTUAL', 'CONFIRMED',
          '2026-01-02T07:00:00Z', '2026-01-02T08:00:00Z', '空完成比例',
          'MEDIUM', '', '', NULL, $6, $7, $8, CURRENT_TIMESTAMP)`,
      [
        ids.segment,
        ids.zeroSegment,
        ids.fullUnlinkedSegment,
        ids.nullCompletionSegment,
        ids.person,
        ids.task,
        ids.account,
        ids.createdAt,
      ],
    );
    await client.query(
      `INSERT INTO "InAppNotification" (
         id, "eventKey", "recipientAccountId", category, title, "entityType", "entityId"
       ) VALUES ($1, $2, $3, 'TASK', '既有通知', 'Task', $4)`,
      [ids.inApp, `existing:${ids.inApp}`, ids.account, ids.task],
    );
    await client.query(
      `INSERT INTO "NotificationOutbox" (
         id, "eventKey", channel, type, payload, "updatedAt"
       ) VALUES ($1, $2, 'project-management', 'existing_event', '{}', CURRENT_TIMESTAMP)`,
      [ids.outbox, `existing:${ids.outbox}`],
    );
    await client.query(
      `INSERT INTO "NotificationOutboxRecipient" (
         id, "outboxId", "openId", "updatedAt"
       ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
      [ids.recipient, ids.outbox, `ou_${ids.recipient}`],
    );

    await client.query(
      `ALTER TABLE "SystemRoleAssignment"
         DROP CONSTRAINT "SystemRoleAssignment_scope_required_check",
         DROP CONSTRAINT "SystemRoleAssignment_active_global_role_check"`,
    );
    await client.query(
      `ALTER TABLE "TaskMember"
         DROP CONSTRAINT "TaskMember_active_role_check"`,
    );
    await client.query(
      `INSERT INTO "SystemRoleAssignment" (
         id, "accountId", role, team, "techGroup", "createdAt"
       ) VALUES ($1, $2, 'AUDITOR', '', '', $3)`,
      [ids.activeLegacySystemRole, ids.account, ids.createdAt],
    );
    await client.query(
      `INSERT INTO "TaskMember" (
         id, "taskId", "personId", role, "createdByAccountId", "createdAt"
       ) VALUES ($1, $2, $3, 'VIEWER', $4, $5)`,
      [
        ids.activeLegacyTaskMember,
        ids.task,
        ids.activeLegacyPerson,
        ids.account,
        ids.createdAt,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return ids;
}

async function executeMigrationSql(client: Client, sql: string) {
  try {
    await client.query(sql);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function legacySourceCounts(client: Client) {
  const result = await client.query<{
    completion: string;
    systemRoles: string;
    taskRoles: string;
  }>(
    `SELECT
       (SELECT count(*)::TEXT FROM "SystemRoleAssignment"
        WHERE "revokedAt" IS NOT NULL
          AND role::TEXT NOT IN ('SUPER_ADMINISTRATOR', 'PROJECT_ADMINISTRATOR'))
         AS "systemRoles",
       (SELECT count(*)::TEXT FROM "TaskMember"
        WHERE "removedAt" IS NOT NULL
          AND role::TEXT NOT IN ('OWNER', 'PARTICIPANT')) AS "taskRoles",
       (SELECT count(*)::TEXT FROM "WorkSegment"
        WHERE "completionPercent" IS NOT NULL) AS completion`,
  );
  const row = result.rows[0];
  return {
    completion: Number(row?.completion ?? 0),
    systemRoles: Number(row?.systemRoles ?? 0),
    taskRoles: Number(row?.taskRoles ?? 0),
  };
}

function databaseCommandEnvironment(targetUrl: URL): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: targetUrl.toString(),
    DB_WAIT_MS: "10000",
    NOTIFICATION_DELIVERY_DISABLED: "true",
  };
  delete env.SHADOW_DATABASE_URL;
  return env;
}

function runPrismaDeploy(targetUrl: URL, configPath: string) {
  return spawnSync(
    "npx",
    ["prisma", "migrate", "deploy", "--config", configPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: databaseCommandEnvironment(targetUrl),
    },
  );
}

function runControlledDeploy(targetUrl: URL) {
  return spawnSync("npm", ["run", "db:deploy"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: databaseCommandEnvironment(targetUrl),
  });
}

function startControlledDeploy(targetUrl: URL) {
  const child = spawn("npm", ["run", "db:deploy"], {
    cwd: process.cwd(),
    env: databaseCommandEnvironment(targetUrl),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
  return { child, completion };
}

async function waitForRetirementMigrationLock(observer: Client) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query LIKE '%LOCK TABLE%SystemRoleAssignment%'
       ) AS waiting`,
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("未观察到历史退役 migration 等待源表写事务");
}

async function waitForRetirementMigrationBlockedBy(
  observer: Client,
  blockerPid: number,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND $1 = ANY(pg_blocking_pids(pid))
       ) AS waiting`,
      [blockerPid],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("未观察到历史退役 migration 等待测试同步锁");
}

function runTsxScript(targetUrl: URL, scriptPath: string) {
  return spawnSync(
    path.join(process.cwd(), "node_modules", ".bin", "tsx"),
    [scriptPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: databaseCommandEnvironment(targetUrl),
    },
  );
}

function commandOutput(result: { stdout?: string | null; stderr?: string | null }) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

async function notificationCounts(client: Client) {
  const result = await client.query<{
    inApp: string;
    outbox: string;
    recipients: string;
  }>(
    `SELECT
       (SELECT count(*)::TEXT FROM "InAppNotification") AS "inApp",
       (SELECT count(*)::TEXT FROM "NotificationOutbox") AS outbox,
       (SELECT count(*)::TEXT FROM "NotificationOutboxRecipient") AS recipients`,
  );
  return result.rows[0];
}

async function notificationSnapshot(client: Client) {
  const result = await client.query<{ snapshot: Record<string, unknown> }>(
    `SELECT jsonb_build_object(
       'inApp', COALESCE((
         SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id)
         FROM "InAppNotification" item
       ), '[]'::jsonb),
       'outbox', COALESCE((
         SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id)
         FROM "NotificationOutbox" item
       ), '[]'::jsonb),
       'recipients', COALESCE((
         SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id)
         FROM "NotificationOutboxRecipient" item
       ), '[]'::jsonb)
     ) AS snapshot`,
  );
  return result.rows[0]?.snapshot;
}

async function auditCount(client: Client, pattern: string) {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::TEXT AS count FROM "DomainAuditEvent" WHERE id LIKE $1`,
    [pattern],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function enumValues(client: Client, typeName: string) {
  const result = await client.query<{ value: string }>(
    `SELECT enum.enumlabel AS value
     FROM pg_enum enum
     JOIN pg_type type ON type.oid = enum.enumtypid
     WHERE type.typname = $1
     ORDER BY enum.enumsortorder`,
    [typeName],
  );
  return result.rows.map((row) => row.value);
}

async function columnExists(client: Client, tableName: string, columnName: string) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
       AND column_name = $2`,
    [tableName, columnName],
  );
  return result.rowCount === 1;
}

async function rowsByIds(client: Client, tableName: string, ids: string[]) {
  if (tableName !== "SystemRoleAssignment" && tableName !== "TaskMember") {
    throw new Error("不支持的测试表");
  }
  const result = await client.query<{ id: string }>(
    `SELECT id FROM "${tableName}" WHERE id = ANY($1::TEXT[]) ORDER BY id`,
    [ids],
  );
  return result.rows;
}

async function auditGuardNames(client: Client) {
  const result = await client.query<{ name: string }>(
    `SELECT tgname AS name
     FROM pg_trigger
     WHERE tgrelid = '"DomainAuditEvent"'::regclass
       AND NOT tgisinternal
     ORDER BY tgname`,
  );
  return result.rows.map((row) => row.name);
}
