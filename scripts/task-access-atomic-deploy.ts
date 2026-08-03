import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export const TASK_ACCESS_MIGRATION =
  "20260803120000_task_global_visibility_participants_admin_approval";

const TASK_ACCESS_DEPLOY_LOCK = 2_026_080_302;
const TASK_ACCESS_MIGRATION_PATH = path.join(
  "prisma",
  "migrations",
  TASK_ACCESS_MIGRATION,
  "migration.sql",
);
const BLOCKER_TYPE = "TaskMemberRole_legacy";
const BLOCKER_ENUM_VALUE = "__ATOMIC_DEPLOY_BLOCKER__";

type PrismaCommandResult = {
  status: number | null;
};

type AtomicDeployInput = {
  cwd: string;
  databaseUrl: string;
  runPrisma(args: string[], allowFailure?: boolean): PrismaCommandResult;
};

type MigrationRow = {
  finishedAt: Date | null;
  migrationName: string;
  rolledBackAt: Date | null;
};

/**
 * Prisma's PostgreSQL migration runner does not wrap an entire migration file
 * in a transaction. This compatibility gate applies the one irreversible Task
 * migration together with its Prisma history row in a single PostgreSQL
 * transaction. All other migrations remain managed by Prisma.
 */
export async function ensureTaskAccessMigrationAppliedAtomically({
  cwd,
  databaseUrl,
  runPrisma,
}: AtomicDeployInput): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [
      TASK_ACCESS_DEPLOY_LOCK,
    ]);
    if (await isMigrationApplied(client, TASK_ACCESS_MIGRATION)) return;

    await recoverOwnedBlockerIfNeeded(client, runPrisma);
    const earlierMigrations = await migrationNamesBeforeTaskAccess(cwd);
    let appliedMigrations = await appliedMigrationNames(client);
    const missingEarlierMigrations = earlierMigrations.filter(
      (migrationName) => !appliedMigrations.has(migrationName),
    );

    if (missingEarlierMigrations.length > 0) {
      await applyEarlierMigrationsWithPrismaBlocker(client, runPrisma);
      appliedMigrations = await appliedMigrationNames(client);
      const stillMissing = earlierMigrations.filter(
        (migrationName) => !appliedMigrations.has(migrationName),
      );
      if (stillMissing.length > 0) {
        throw new Error(
          `Task access 原子部署失败：前置 migration 未完成：${stillMissing.join(", ")}`,
        );
      }
    }

    await applyTaskAccessMigrationInTransaction(client, cwd);
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1::bigint)", [TASK_ACCESS_DEPLOY_LOCK])
      .catch(() => undefined);
    await client.end();
  }
}

async function migrationNamesBeforeTaskAccess(cwd: string): Promise<string[]> {
  const migrationsDirectory = path.join(cwd, "prisma", "migrations");
  return (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter(
      (entry) => entry.isDirectory() && entry.name < TASK_ACCESS_MIGRATION,
    )
    .map((entry) => entry.name)
    .sort();
}

async function migrationTableExists(client: pg.Client): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`,
  );
  return result.rows[0]?.exists ?? false;
}

async function migrationRows(client: pg.Client): Promise<MigrationRow[]> {
  if (!(await migrationTableExists(client))) return [];
  const result = await client.query<MigrationRow>(
    `SELECT
       migration_name AS "migrationName",
       finished_at AS "finishedAt",
       rolled_back_at AS "rolledBackAt"
     FROM "_prisma_migrations"
     WHERE migration_name = $1
     ORDER BY started_at`,
    [TASK_ACCESS_MIGRATION],
  );
  return result.rows;
}

async function appliedMigrationNames(client: pg.Client): Promise<Set<string>> {
  if (!(await migrationTableExists(client))) return new Set();
  const result = await client.query<{ migrationName: string }>(
    `SELECT migration_name AS "migrationName"
     FROM "_prisma_migrations"
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
  );
  return new Set(result.rows.map((row) => row.migrationName));
}

async function isMigrationApplied(
  client: pg.Client,
  migrationName: string,
): Promise<boolean> {
  return (await appliedMigrationNames(client)).has(migrationName);
}

async function blockerTypeState(client: pg.Client): Promise<
  "ABSENT" | "OWNED" | "FOREIGN"
> {
  const result = await client.query<{ labels: string[] | null }>(
    `SELECT array_agg(enum.enumlabel::text ORDER BY enum.enumsortorder) AS labels
     FROM pg_type type
     JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
     LEFT JOIN pg_enum enum ON enum.enumtypid = type.oid
     WHERE namespace.nspname = 'public' AND type.typname = $1
     GROUP BY type.oid`,
    [BLOCKER_TYPE],
  );
  const labels = result.rows[0]?.labels;
  if (!labels) return "ABSENT";
  return labels.length === 1 && labels[0] === BLOCKER_ENUM_VALUE
    ? "OWNED"
    : "FOREIGN";
}

async function recoverOwnedBlockerIfNeeded(
  client: pg.Client,
  runPrisma: AtomicDeployInput["runPrisma"],
): Promise<void> {
  const blockerState = await blockerTypeState(client);
  const activeFailures = (await migrationRows(client)).filter(
    (row) => !row.finishedAt && !row.rolledBackAt,
  );
  if (blockerState === "FOREIGN") {
    throw new Error(
      "Task access 原子部署检测到非本工具创建的 TaskMemberRole_legacy；数据库可能曾发生部分迁移，请从备份恢复或人工审计",
    );
  }
  if (activeFailures.length > 0 && blockerState !== "OWNED") {
    throw new Error(
      "Task access migration 存在未解决的失败记录且没有安全阻断标记；拒绝自动猜测数据库状态",
    );
  }
  if (blockerState !== "OWNED") return;

  if (activeFailures.length > 0) {
    const result = runPrisma(
      ["migrate", "resolve", "--rolled-back", TASK_ACCESS_MIGRATION],
      false,
    );
    if (result.status !== 0) {
      throw new Error("无法恢复 Task access 原子部署的安全阻断记录");
    }
  }
  await client.query(`DROP TYPE "TaskMemberRole_legacy"`);
}

async function applyEarlierMigrationsWithPrismaBlocker(
  client: pg.Client,
  runPrisma: AtomicDeployInput["runPrisma"],
): Promise<void> {
  const blockerState = await blockerTypeState(client);
  if (blockerState !== "ABSENT") {
    throw new Error("Task access 原子部署阻断类型状态异常");
  }
  await client.query(
    `CREATE TYPE "TaskMemberRole_legacy" AS ENUM ('${BLOCKER_ENUM_VALUE}')`,
  );

  const deployResult = runPrisma(["migrate", "deploy"], true);
  const rowsAfterDeploy = await migrationRows(client);
  const activeFailure = rowsAfterDeploy.some(
    (row) => !row.finishedAt && !row.rolledBackAt,
  );
  const stateAfterDeploy = await blockerTypeState(client);
  if (
    deployResult.status === 0 ||
    !activeFailure ||
    stateAfterDeploy !== "OWNED"
  ) {
    if (stateAfterDeploy === "OWNED") {
      await client.query(`DROP TYPE "TaskMemberRole_legacy"`);
    }
    throw new Error(
      "Prisma 未在 Task access migration 的首条语句按预期安全停止；拒绝继续部署",
    );
  }

  const resolveResult = runPrisma(
    ["migrate", "resolve", "--rolled-back", TASK_ACCESS_MIGRATION],
    false,
  );
  if (resolveResult.status !== 0) {
    throw new Error("无法将 Task access 安全阻断记录标记为已回滚");
  }
  await client.query(`DROP TYPE "TaskMemberRole_legacy"`);
}

async function applyTaskAccessMigrationInTransaction(
  client: pg.Client,
  cwd: string,
): Promise<void> {
  const migrationPath = path.join(cwd, TASK_ACCESS_MIGRATION_PATH);
  const migrationBuffer = await readFile(migrationPath);
  const migrationSql = migrationBuffer.toString("utf8");
  const checksum = createHash("sha256").update(migrationBuffer).digest("hex");
  const migrationId = randomUUID();

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO "_prisma_migrations"
         (id, checksum, migration_name, started_at, applied_steps_count)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, 0)`,
      [migrationId, checksum, TASK_ACCESS_MIGRATION],
    );
    await client.query(migrationSql);
    await client.query(
      `UPDATE "_prisma_migrations"
       SET finished_at = CURRENT_TIMESTAMP, applied_steps_count = 1
       WHERE id = $1`,
      [migrationId],
    );
    await client.query("COMMIT");
    console.log(
      `[db:deploy] atomically applied ${TASK_ACCESS_MIGRATION}`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
