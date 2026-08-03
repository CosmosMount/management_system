import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { ensureTaskAccessMigrationAppliedAtomically } from "../scripts/task-access-atomic-deploy";

const MIGRATIONS_DIR = path.join(process.cwd(), "prisma/migrations");
const TASK_ACCESS_PREFLIGHT =
  "20260803115900_active_global_approval_administrator_preflight";
const TASK_ACCESS_MIGRATION =
  "20260803120000_task_global_visibility_participants_admin_approval";
const BACKFILLED_GUARD_MIGRATIONS = [
  "20260803115900_active_global_approval_administrator_preflight",
  "20260803115950_durable_global_approval_administrator_guard",
  "20260803115975_refine_global_approval_administrator_role_guard",
  "20260803115980_serialize_global_approval_administrator_guard",
  "20260803115990_atomic_global_approval_administrator_guard",
  "20260803115992_refine_atomic_global_approval_administrator_guard",
  "20260803115995_finalize_atomic_global_approval_administrator_guard",
  "20260803123050_remove_refined_global_approval_administrator_role_guard",
  "20260803123075_remove_serialized_global_approval_administrator_guard",
  "20260803123100_remove_durable_global_approval_administrator_guard",
  "20260803123105_cleanup_all_legacy_global_approval_administrator_guards",
  "20260803123110_remove_residual_global_approval_administrator_guard_function",
] as const;

test("controlled db deploy atomically applies Task access and backfills real Prisma history", async () => {
  test.setTimeout(180_000);
  const sourceUrl = safeLocalTestDatabaseUrl();
  const sourceDatabaseName = sourceUrl.pathname.replace(/^\//, "");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `${sourceDatabaseName.slice(0, 18)}_${suffix}_atomic_deploy_test`;
  if (!/^[A-Za-z0-9_]+_atomic_deploy_test$/.test(databaseName)) {
    throw new Error("Task access 原子部署临时数据库名称安全校验失败");
  }

  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const targetUrl = new URL(sourceUrl);
  targetUrl.pathname = `/${databaseName}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let target: Client | null = null;
  let temporaryPrismaRoot: string | null = null;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    temporaryPrismaRoot = await createPreTaskMigrationConfig(targetUrl);
    const predecessorDeploy = runPrismaDeploy(
      targetUrl,
      path.join(temporaryPrismaRoot, "prisma.config.ts"),
    );
    expect(commandOutput(predecessorDeploy)).toContain(
      "All migrations have been successfully applied",
    );
    expect(predecessorDeploy.status).toBe(0);

    target = new Client({ connectionString: targetUrl.toString() });
    await target.connect();
    const simulatedFailureId = randomUUID();
    await target.query(
      `INSERT INTO "_prisma_migrations"
         (id, checksum, migration_name, started_at, applied_steps_count)
       VALUES ($1, 'simulated-blocker-recovery', $2, CURRENT_TIMESTAMP, 0)`,
      [simulatedFailureId, TASK_ACCESS_MIGRATION],
    );
    await target.query(
      `CREATE TYPE "TaskMemberRole_legacy" AS ENUM ('__ATOMIC_DEPLOY_BLOCKER__')`,
    );
    await expect(
      ensureTaskAccessMigrationAppliedAtomically({
        cwd: process.cwd(),
        databaseUrl: targetUrl.toString(),
        runPrisma: () => ({ status: 1 }),
      }),
    ).rejects.toThrow(/无法恢复 Task access 原子部署的安全阻断记录/);
    const preservedRecoveryState = await target.query<{
      blockerType: string | null;
      unresolvedFailureCount: string;
    }>(
      `SELECT
         to_regtype('"TaskMemberRole_legacy"')::text AS "blockerType",
         (SELECT count(*)::text
          FROM "_prisma_migrations"
          WHERE id = $1 AND finished_at IS NULL AND rolled_back_at IS NULL)
           AS "unresolvedFailureCount"`,
      [simulatedFailureId],
    );
    expect(preservedRecoveryState.rows).toEqual([
      {
        blockerType: '"TaskMemberRole_legacy"',
        unresolvedFailureCount: "1",
      },
    ]);
    await target.query(`DROP TYPE "TaskMemberRole_legacy"`);
    await target.query(`DELETE FROM "_prisma_migrations" WHERE id = $1`, [
      simulatedFailureId,
    ]);

    const initialResolveFailureId = randomUUID();
    await expect(
      ensureTaskAccessMigrationAppliedAtomically({
        cwd: process.cwd(),
        databaseUrl: targetUrl.toString(),
        runPrisma: (args) => {
          if (args[0] === "migrate" && args[1] === "deploy") {
            insertUnresolvedMigrationWithPsql(
              targetUrl,
              initialResolveFailureId,
            );
          }
          return { status: 1 };
        },
      }),
    ).rejects.toThrow(/无法将 Task access 安全阻断记录标记为已回滚/);
    const preservedInitialRecoveryState = await target.query<{
      blockerType: string | null;
      unresolvedFailureCount: string;
    }>(
      `SELECT
         to_regtype('"TaskMemberRole_legacy"')::text AS "blockerType",
         (SELECT count(*)::text
          FROM "_prisma_migrations"
          WHERE id = $1 AND finished_at IS NULL AND rolled_back_at IS NULL)
           AS "unresolvedFailureCount"`,
      [initialResolveFailureId],
    );
    expect(preservedInitialRecoveryState.rows).toEqual([
      {
        blockerType: '"TaskMemberRole_legacy"',
        unresolvedFailureCount: "1",
      },
    ]);
    await target.query(`DROP TYPE "TaskMemberRole_legacy"`);
    await target.query(`DELETE FROM "_prisma_migrations" WHERE id = $1`, [
      initialResolveFailureId,
    ]);
    const fixture = await seedLegacyAtomicDeployFixture(target);

    const blockedDeploy = runControlledDeploy(targetUrl);
    expect(blockedDeploy.status).not.toBe(0);
    expect(commandOutput(blockedDeploy)).toMatch(/have no active OWNER/);

    const blockedState = await target.query<{
      activeMainHistory: string;
      participantRole: string;
      policyColumns: string;
      zeroOwnerMemberCount: string;
    }>(
      `SELECT
         (SELECT count(*)::text
          FROM "_prisma_migrations"
          WHERE migration_name = $2
            AND finished_at IS NOT NULL
            AND rolled_back_at IS NULL) AS "activeMainHistory",
         (SELECT count(*)::text
          FROM pg_enum
          WHERE enumtypid = '"TaskMemberRole"'::regtype
            AND enumlabel = 'PARTICIPANT') AS "participantRole",
         (SELECT count(*)::text
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'Task'
            AND column_name IN ('revisionApprovalMode', 'allowSelfReview')) AS "policyColumns",
         (SELECT count(*)::text
          FROM "TaskMember"
          WHERE "taskId" = $1 AND "removedAt" IS NULL) AS "zeroOwnerMemberCount"`,
      [fixture.zeroOwnerTaskId, TASK_ACCESS_MIGRATION],
    );
    expect(blockedState.rows).toEqual([
      {
        activeMainHistory: "0",
        participantRole: "0",
        policyColumns: "2",
        zeroOwnerMemberCount: "0",
      },
    ]);

    await target.query(
      `INSERT INTO "TaskMember" (id, "taskId", "personId", role)
       VALUES ($1, $2, $3, 'OWNER')`,
      [randomUUID(), fixture.zeroOwnerTaskId, fixture.ownerPersonId],
    );
    const successfulDeploy = runControlledDeploy(targetUrl);
    expect(commandOutput(successfulDeploy)).toContain(
      `[db:deploy] atomically applied ${TASK_ACCESS_MIGRATION}`,
    );
    expect(successfulDeploy.status).toBe(0);
    await assertFinalMigrationState(target);

    await dropPermanentGuard(target);
    await target.query(
      `DELETE FROM "_prisma_migrations"
       WHERE migration_name = ANY($1::text[])`,
      [[...BACKFILLED_GUARD_MIGRATIONS]],
    );
    const historyBackfillDeploy = runControlledDeploy(targetUrl);
    expect(historyBackfillDeploy.status).toBe(0);
    expect(commandOutput(historyBackfillDeploy)).toContain(
      "All migrations have been successfully applied",
    );
    await assertFinalMigrationState(target);

    const backfilledHistory = await target.query<{ count: string }>(
      `SELECT count(DISTINCT migration_name)::text AS count
       FROM "_prisma_migrations"
       WHERE migration_name = ANY($1::text[])
         AND finished_at IS NOT NULL
         AND rolled_back_at IS NULL`,
      [[...BACKFILLED_GUARD_MIGRATIONS]],
    );
    expect(backfilledHistory.rows[0]?.count).toBe(
      String(BACKFILLED_GUARD_MIGRATIONS.length),
    );
  } finally {
    await target?.end().catch(() => undefined);
    if (temporaryPrismaRoot) {
      await rm(temporaryPrismaRoot, { force: true, recursive: true });
    }
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
});

async function createPreTaskMigrationConfig(targetUrl: URL): Promise<string> {
  const temporaryRootParent = path.join(process.cwd(), ".tmp");
  await mkdir(temporaryRootParent, { recursive: true });
  const temporaryRoot = await mkdtemp(
    path.join(temporaryRootParent, "task-access-atomic-deploy-"),
  );
  const temporaryMigrations = path.join(temporaryRoot, "migrations");
  await mkdir(temporaryMigrations);
  const migrationNames = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && entry.name < TASK_ACCESS_PREFLIGHT,
    )
    .map((entry) => entry.name)
    .sort();
  for (const migrationName of migrationNames) {
    await cp(
      path.join(MIGRATIONS_DIR, migrationName),
      path.join(temporaryMigrations, migrationName),
      { recursive: true },
    );
  }

  const configPath = path.join(temporaryRoot, "prisma.config.ts");
  const schemaPath = path.join(process.cwd(), "prisma", "schema.prisma");
  await writeFile(
    configPath,
    `import { defineConfig } from "prisma/config";\n` +
      `export default defineConfig({\n` +
      `  schema: ${JSON.stringify(schemaPath)},\n` +
      `  migrations: { path: ${JSON.stringify(temporaryMigrations)} },\n` +
      `  datasource: { url: process.env.DATABASE_URL },\n` +
      `});\n`,
    "utf8",
  );
  void targetUrl;
  return temporaryRoot;
}

function runPrismaDeploy(targetUrl: URL, configPath: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: targetUrl.toString(),
    NOTIFICATION_DELIVERY_DISABLED: "true",
  };
  delete env.SHADOW_DATABASE_URL;
  return spawnSync(
    "npx",
    ["prisma", "migrate", "deploy", "--config", configPath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    },
  );
}

function runControlledDeploy(targetUrl: URL) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: targetUrl.toString(),
    DB_WAIT_MS: "10000",
    NOTIFICATION_DELIVERY_DISABLED: "true",
  };
  delete env.SHADOW_DATABASE_URL;
  return spawnSync("npm", ["run", "db:deploy"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
}

function commandOutput(result: ReturnType<typeof spawnSync>) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function insertUnresolvedMigrationWithPsql(targetUrl: URL, migrationId: string) {
  const result = spawnSync(
    "psql",
    [
      targetUrl.toString(),
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `INSERT INTO "_prisma_migrations"
         (id, checksum, migration_name, started_at, applied_steps_count)
       VALUES ('${migrationId}', 'simulated-initial-resolve-failure',
               '${TASK_ACCESS_MIGRATION}', CURRENT_TIMESTAMP, 0)`,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`无法构造原子部署恢复测试状态：${commandOutput(result)}`);
  }
}

async function seedLegacyAtomicDeployFixture(client: Client) {
  const accountId = randomUUID();
  const ownerPersonId = randomUUID();
  const validTaskId = randomUUID();
  const zeroOwnerTaskId = randomUUID();

  await client.query("BEGIN");
  try {
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO "Account" (id, "updatedAt") VALUES ($1, CURRENT_TIMESTAMP)`,
      [accountId],
    );
    await client.query(
      `INSERT INTO "AccountIdentity"
         (id, "accountId", provider, "providerSubject", "tenantId", "openId", "updatedAt")
       VALUES ($1, $2, 'FEISHU', $3, 'default', $4, CURRENT_TIMESTAMP)`,
      [randomUUID(), accountId, `open:${accountId}`, `ou_atomic_${accountId}`],
    );
    await client.query(
      `INSERT INTO "Person" (id, "displayName", "updatedAt")
       VALUES ($1, 'Atomic deploy owner', CURRENT_TIMESTAMP)`,
      [ownerPersonId],
    );
    await insertLegacyTaskAndPlan(
      client,
      validTaskId,
      randomUUID(),
      accountId,
      "Valid atomic deploy Task",
    );
    await insertLegacyTaskAndPlan(
      client,
      zeroOwnerTaskId,
      randomUUID(),
      accountId,
      "Zero Owner atomic deploy Task",
    );
    await client.query(
      `INSERT INTO "TaskMember" (id, "taskId", "personId", role)
       VALUES ($1, $2, $3, 'OWNER')`,
      [randomUUID(), validTaskId, ownerPersonId],
    );
    await client.query(
      `INSERT INTO "SystemRoleAssignment"
         (id, "accountId", role, team, "techGroup")
       VALUES ($1, $2, 'PROJECT_ADMINISTRATOR', '', '')`,
      [randomUUID(), accountId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return { ownerPersonId, zeroOwnerTaskId };
}

async function insertLegacyTaskAndPlan(
  client: Client,
  taskId: string,
  planId: string,
  accountId: string,
  title: string,
) {
  await client.query(
    `INSERT INTO "Task"
       (id, title, "currentPlanVersionId", "revisionApprovalMode",
        "allowSelfReview", "createdByAccountId", "updatedAt")
     VALUES ($1, $2, $3, 'REVIEW_REQUIRED', false, $4, CURRENT_TIMESTAMP)`,
    [taskId, title, planId, accountId],
  );
  await client.query(
    `INSERT INTO "TaskPlanVersion"
       (id, "taskId", "versionNo", status, reason, "createdByAccountId", "updatedAt")
     VALUES ($1, $2, 1, 'CURRENT', 'atomic deploy fixture', $3, CURRENT_TIMESTAMP)`,
    [planId, taskId, accountId],
  );
}

async function dropPermanentGuard(client: Client) {
  await client.query(`
    DROP TRIGGER IF EXISTS "Task_usable_global_administrator_insert_guard_v2" ON "Task";
    DROP TRIGGER IF EXISTS "Account_usable_global_administrator_guard_v2" ON "Account";
    DROP TRIGGER IF EXISTS "Account_usable_global_administrator_update_guard_v2" ON "Account";
    DROP TRIGGER IF EXISTS "Account_usable_global_administrator_delete_guard_v2" ON "Account";
    DROP TRIGGER IF EXISTS "AccountIdentity_usable_global_administrator_guard_v2" ON "AccountIdentity";
    DROP TRIGGER IF EXISTS "AccountIdentity_usable_global_administrator_update_guard_v2" ON "AccountIdentity";
    DROP TRIGGER IF EXISTS "AccountIdentity_usable_global_administrator_delete_guard_v2" ON "AccountIdentity";
    DROP TRIGGER IF EXISTS "SystemRoleAssignment_global_administrator_update_guard_v2" ON "SystemRoleAssignment";
    DROP TRIGGER IF EXISTS "SystemRoleAssignment_global_administrator_delete_guard_v2" ON "SystemRoleAssignment";
    DROP FUNCTION IF EXISTS "assert_usable_global_approval_administrator_v2"();
  `);
}

async function assertFinalMigrationState(client: Client) {
  const result = await client.query<{
    legacyTriggerCount: string;
    mainHistoryCount: string;
    permanentFunction: string | null;
    permanentTriggerCount: string;
    policyColumns: string;
  }>(
    `SELECT
       (SELECT count(*)::text
        FROM "_prisma_migrations"
        WHERE migration_name = $1
          AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL) AS "mainHistoryCount",
       (SELECT count(*)::text
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'Task'
          AND column_name IN ('revisionApprovalMode', 'allowSelfReview')) AS "policyColumns",
       to_regprocedure('"assert_usable_global_approval_administrator_v2"()')::text AS "permanentFunction",
       (SELECT count(*)::text FROM pg_trigger
        WHERE tgname IN (
          'Task_usable_global_administrator_insert_guard_v2',
          'Account_usable_global_administrator_update_guard_v2',
          'Account_usable_global_administrator_delete_guard_v2',
          'AccountIdentity_usable_global_administrator_update_guard_v2',
          'AccountIdentity_usable_global_administrator_delete_guard_v2',
          'SystemRoleAssignment_global_administrator_update_guard_v2',
          'SystemRoleAssignment_global_administrator_delete_guard_v2'
        )) AS "permanentTriggerCount",
       (SELECT count(*)::text FROM pg_trigger
        WHERE tgname IN (
          'Account_global_approval_administrator_guard',
          'AccountIdentity_global_approval_administrator_guard',
          'SystemRoleAssignment_global_approval_administrator_guard',
          'SystemRoleAssignment_global_administrator_update_guard',
          'SystemRoleAssignment_global_administrator_delete_guard',
          'Task_global_approval_administrator_guard'
        )) AS "legacyTriggerCount"`,
    [TASK_ACCESS_MIGRATION],
  );
  expect(result.rows).toEqual([
    {
      legacyTriggerCount: "0",
      mainHistoryCount: "1",
      permanentFunction: "assert_usable_global_approval_administrator_v2()",
      permanentTriggerCount: "7",
      policyColumns: "0",
    },
  ]);
}

function safeLocalTestDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const url = new URL(raw);
  const databaseName = url.pathname.replace(/^\//, "");
  if (
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    !databaseName.endsWith("_test") ||
    /prod(?:uction)?/i.test(databaseName)
  ) {
    throw new Error("拒绝在非本机测试数据库执行 Task access 原子部署回归");
  }
  return url;
}
