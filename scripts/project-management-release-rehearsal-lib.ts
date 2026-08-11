import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";

const CONFIRMATION = "LOCAL_ISOLATED_REHEARSAL";
const SAFE_SOURCE_DATABASE = /^[A-Za-z0-9_]+_(?:test|snapshot)$/;
const SAFE_REHEARSAL_DATABASE = /^pmrel_[a-f0-9]{16}_[a-z]+_test$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const EXPECTED_REHEARSAL_MIGRATIONS = [
  "20260801110000_remove_resource_conflicts_and_allocation",
] as const;
const PROTECTED_TABLE_NAMES = [
  "User",
  "UserRole",
  "ProcurementBudgetPool",
  "PurchaseOrder",
  "PurchaseItem",
  "ProcessingVendor",
  "Feedback",
  "FeedbackMessage",
  "FeedbackAttachment",
  "FileAsset",
  "ProcurementFeishuCard",
  "NotificationOutbox",
  "NotificationOutboxRecipient",
] as const;

export type ReleaseRehearsalScenario = "empty" | "shared_snapshot";

type BaselineTable = {
  rowCount: number;
  stableHash: string;
};

type P0BaselineReport = {
  protectedTables: Record<string, BaselineTable>;
  safetyChecks: {
    forbiddenLegacyColumns: unknown[];
    legacyEnumCount: number;
    legacyTableCount: number;
    progressOutboxRows: number;
    projectManagerRoleRows: number;
  };
};

type IdentityBackfillReport = {
  alreadyExisting: number;
  conflicts: unknown[];
  created: number;
  dryRun: boolean;
  totalUsers: number;
  wouldCreate: number;
};

type ManifestEntry = {
  rowCount: number;
  stableHash: string;
};

type DatabaseManifest = {
  stableHash: string;
  tables: Record<string, ManifestEntry>;
};

type UploadManifest = {
  bytes: number;
  files: number;
  stableHash: string;
};

type FutureProjectNotificationRows = {
  inAppNotifications: Record<string, unknown>[];
  notificationPreferences: Record<string, unknown>[];
};

export type ReleaseRehearsalReport = {
  businessTimezone: "Asia/Shanghai";
  cleanup: {
    rehearsalDatabasesRemoved: boolean;
    temporaryFilesRemoved: boolean;
  };
  databaseRestore: {
    source: DatabaseManifest;
    restored: DatabaseManifest;
    verified: boolean;
  };
  generatedAt: string;
  identityBackfill: {
    apply: IdentityBackfillReport;
    dryRun: IdentityBackfillReport;
    repeatedApply: IdentityBackfillReport;
    verifiedIdempotent: boolean;
  };
  migration: {
    appliedMigrationCount: number;
    appliedMigrations: string[];
    beforeMigrationCount: number;
    expectedMigrationsApplied: boolean;
    protectedTablesAfter: Record<string, BaselineTable>;
    protectedTablesBefore: Record<string, BaselineTable> | null;
    sharedDataUnchanged: boolean;
  };
  rehearsalId: string;
  safety: P0BaselineReport["safetyChecks"] & {
    notificationDeliveryDisabled: true;
    sourceDatabaseName: string;
  };
  scenario: ReleaseRehearsalScenario;
  uploadRestore: {
    backup: UploadManifest;
    restored: UploadManifest;
    source: UploadManifest;
    verified: boolean;
  };
};

type RunReleaseRehearsalInput = {
  confirmation: string | undefined;
  notificationDeliveryDisabled: string | undefined;
  repositoryRoot?: string;
  scenario: ReleaseRehearsalScenario;
  sourceDatabaseUrl: string | undefined;
  uploadSourceDirectory?: string | undefined;
};

type ParsedDatabaseUrl = {
  databaseName: string;
  url: URL;
};

function parseSafeSourceDatabaseUrl(value: string | undefined): ParsedDatabaseUrl {
  if (!value) throw new Error("DATABASE_URL is required for a release rehearsal");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Release rehearsals only accept a local PostgreSQL snapshot");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!SAFE_SOURCE_DATABASE.test(databaseName)) {
    throw new Error(
      "Release rehearsal source database must end with _test or _snapshot",
    );
  }
  return { databaseName, url };
}

function databaseUrlForName(source: URL, databaseName: string): string {
  if (!SAFE_REHEARSAL_DATABASE.test(databaseName)) {
    throw new Error("Generated rehearsal database name is invalid");
  }
  const result = new URL(source.toString());
  result.pathname = `/${databaseName}`;
  return result.toString();
}

function maintenanceDatabaseUrl(source: URL): string {
  const result = new URL(source.toString());
  result.pathname = "/postgres";
  return result.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function commandEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPLY_PM_IDENTITY_BACKFILL: undefined,
    CHECKPOINT_DISABLE: "1",
    DATABASE_URL: databaseUrl,
    NOTIFICATION_DELIVERY_DISABLED: "true",
    SHADOW_DATABASE_URL: undefined,
  };
}

function postgresCommandEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  return {
    ...process.env,
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGHOST: url.hostname,
    PGPASSWORD: decodeURIComponent(url.password),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
  };
}

function runCommand({
  args,
  command,
  cwd,
  env,
}: {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(
      `${path.basename(command)} failed with exit ${result.status ?? "unknown"}: ${output.slice(-4_000)}`,
    );
  }
  return result.stdout;
}

function runTsxJson<T>({
  databaseUrl,
  repositoryRoot,
  script,
  extraEnvironment = {},
}: {
  databaseUrl: string;
  extraEnvironment?: Partial<NodeJS.ProcessEnv>;
  repositoryRoot: string;
  script: string;
}): T {
  const output = runCommand({
    args: [script],
    command: path.join(repositoryRoot, "node_modules", ".bin", "tsx"),
    cwd: repositoryRoot,
    env: {
      ...commandEnvironment(databaseUrl),
      ...extraEnvironment,
    },
  });
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(`${script} did not return a JSON report`);
  }
}

async function recreateDatabase(
  adminClient: pg.Client,
  databaseName: string,
): Promise<void> {
  if (!SAFE_REHEARSAL_DATABASE.test(databaseName)) {
    throw new Error("Refusing to recreate a non-rehearsal database");
  }
  await adminClient.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [databaseName],
  );
  await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  await adminClient.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
}

async function dropDatabase(
  adminClient: pg.Client,
  databaseName: string,
): Promise<void> {
  if (!SAFE_REHEARSAL_DATABASE.test(databaseName)) {
    throw new Error("Refusing to drop a non-rehearsal database");
  }
  await adminClient.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [databaseName],
  );
  await adminClient.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
}

function dumpDatabase({
  databaseUrl,
  dumpPath,
  repositoryRoot,
}: {
  databaseUrl: string;
  dumpPath: string;
  repositoryRoot: string;
}): void {
  runCommand({
    args: [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--file=${dumpPath}`,
    ],
    command: "pg_dump",
    cwd: repositoryRoot,
    env: postgresCommandEnvironment(databaseUrl),
  });
}

function restoreDatabase({
  databaseUrl,
  dumpPath,
  repositoryRoot,
}: {
  databaseUrl: string;
  dumpPath: string;
  repositoryRoot: string;
}): void {
  const targetDatabaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.replace(/^\//, ""),
  );
  if (!SAFE_REHEARSAL_DATABASE.test(targetDatabaseName)) {
    throw new Error("Refusing to restore into a non-rehearsal database");
  }
  runCommand({
    args: [
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      `--dbname=${targetDatabaseName}`,
      dumpPath,
    ],
    command: "pg_restore",
    cwd: repositoryRoot,
    env: postgresCommandEnvironment(databaseUrl),
  });
}

async function collectDatabaseManifest(
  databaseUrl: string,
): Promise<DatabaseManifest> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tableResult = await client.query<{ tableName: string }>(`
      SELECT table_name AS "tableName"
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const tables: Record<string, ManifestEntry> = {};
    for (const { tableName } of tableResult.rows) {
      const result = await client.query<{ rowCount: string; stableHash: string }>(`
        SELECT
          COUNT(*)::text AS "rowCount",
          COALESCE(md5(string_agg("rowHash", '' ORDER BY "rowHash")), '')
            AS "stableHash"
        FROM (
          SELECT md5(to_jsonb(source_row)::text) AS "rowHash"
          FROM ${quoteIdentifier(tableName)} AS source_row
        ) AS row_hashes
      `);
      tables[tableName] = {
        rowCount: Number(result.rows[0]?.rowCount ?? 0),
        stableHash: result.rows[0]?.stableHash ?? "",
      };
    }
    const stableHash = createHash("sha256")
      .update(JSON.stringify(tables))
      .digest("hex");
    return { stableHash, tables };
  } finally {
    await client.end();
  }
}

async function listAppliedMigrations(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const exists = await client.query<{ exists: boolean }>(`
      SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists
    `);
    if (!exists.rows[0]?.exists) return [];
    const result = await client.query<{ migrationName: string }>(`
      SELECT migration_name AS "migrationName"
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name
    `);
    return result.rows.map((row) => row.migrationName);
  } finally {
    await client.end();
  }
}

async function prepareSharedSnapshotBeforeExpectedMigrations(
  databaseUrl: string,
): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const applied = await listAppliedMigrations(databaseUrl);
    for (const migration of EXPECTED_REHEARSAL_MIGRATIONS) {
      if (!applied.includes(migration)) {
        throw new Error(
          `Shared snapshot source is missing expected migration ${migration}`,
        );
      }
    }
    // Reconstruct the removed schema with empty conflict tables so the shared
    // snapshot exercises the destructive migration from its real predecessor.
    await client.query(
      'ALTER TYPE "ProjectManagementNotificationCategory" ADD VALUE IF NOT EXISTS \'RESOURCE_CONFLICT\'',
    );
    await client.query("BEGIN");
    await client.query(`
      CREATE TYPE "ResourceConflictKind" AS ENUM (
        'ALLOCATION_OVER_LIMIT', 'MISSING_ALLOCATION',
        'HIGH_PRIORITY_OVERLAP', 'LEAD_ROLE_OVERLAP',
        'UNAVAILABLE_TIME', 'REVISION_OVERLAP', 'ACTUAL_OVERLOAD'
      );
      CREATE TYPE "ResourceConflictSeverity" AS ENUM (
        'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
      );
      CREATE TYPE "ResourceConflictStatus" AS ENUM (
        'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'IGNORED'
      );

      ALTER TABLE "WorkSegment" ADD COLUMN "allocation" DECIMAL(5,2);
      ALTER TABLE "WorkSegment"
        ADD CONSTRAINT "WorkSegment_allocation_range_check"
        CHECK ("allocation" IS NULL OR ("allocation" > 0 AND "allocation" <= 100));

      CREATE TABLE "ResourceConflict" (
        "id" TEXT NOT NULL,
        "personId" TEXT NOT NULL,
        "kind" "ResourceConflictKind" NOT NULL,
        "startAt" TIMESTAMPTZ(6) NOT NULL,
        "endAt" TIMESTAMPTZ(6) NOT NULL,
        "severity" "ResourceConflictSeverity" NOT NULL,
        "status" "ResourceConflictStatus" NOT NULL DEFAULT 'OPEN',
        "fingerprint" TEXT NOT NULL,
        "explanation" JSONB NOT NULL DEFAULT '{}',
        "detectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "acknowledgedAt" TIMESTAMPTZ(6),
        "resolvedAt" TIMESTAMPTZ(6),
        "ignoredUntil" TIMESTAMPTZ(6),
        "resolvedByAccountId" TEXT,
        "resolutionNote" TEXT NOT NULL DEFAULT '',
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ResourceConflict_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "ResourceConflict_personId_fkey"
          FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT "ResourceConflict_resolvedByAccountId_fkey"
          FOREIGN KEY ("resolvedByAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE
      );
      CREATE UNIQUE INDEX "ResourceConflict_fingerprint_key"
        ON "ResourceConflict"("fingerprint");

      CREATE TABLE "ConflictSegment" (
        "id" TEXT NOT NULL,
        "conflictId" TEXT NOT NULL,
        "segmentId" TEXT NOT NULL,
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ConflictSegment_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "ConflictSegment_conflictId_fkey"
          FOREIGN KEY ("conflictId") REFERENCES "ResourceConflict"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "ConflictSegment_segmentId_fkey"
          FOREIGN KEY ("segmentId") REFERENCES "WorkSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT "ConflictSegment_conflictId_segmentId_key"
          UNIQUE ("conflictId", "segmentId")
      );

      CREATE TABLE "ProjectManagementScanCheckpoint" (
        "key" TEXT NOT NULL,
        "cursor" JSONB NOT NULL DEFAULT '{}',
        "lastStartedAt" TIMESTAMPTZ(6),
        "lastCompletedAt" TIMESTAMPTZ(6),
        "lastFullScanAt" TIMESTAMPTZ(6),
        "lastError" TEXT NOT NULL DEFAULT '',
        "lockVersion" INTEGER NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ProjectManagementScanCheckpoint_pkey" PRIMARY KEY ("key")
      );
    `);
    await client.query(
      'DELETE FROM "_prisma_migrations" WHERE migration_name = ANY($1::text[])',
      [[...EXPECTED_REHEARSAL_MIGRATIONS]],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function stageFutureProjectNotificationRows(
  databaseUrl: string,
): Promise<FutureProjectNotificationRows> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const notificationPreferences = await client.query<Record<string, unknown>>(
      `SELECT * FROM "NotificationPreference" WHERE "category"::text = 'PROJECT' ORDER BY "id"`,
    );
    const inAppNotifications = await client.query<Record<string, unknown>>(
      `SELECT * FROM "InAppNotification" WHERE "category"::text = 'PROJECT' ORDER BY "id"`,
    );
    await client.query(
      `DELETE FROM "NotificationPreference" WHERE "category"::text = 'PROJECT'`,
    );
    await client.query(
      `DELETE FROM "InAppNotification" WHERE "category"::text = 'PROJECT'`,
    );
    await client.query("COMMIT");
    return {
      inAppNotifications: inAppNotifications.rows,
      notificationPreferences: notificationPreferences.rows,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function restoreFutureProjectNotificationRows(
  databaseUrl: string,
  rows: FutureProjectNotificationRows,
): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // PROJECT was introduced after the migration being replayed. Re-add the
    // committed enum value before restoring the protected snapshot rows.
    await client.query(
      `ALTER TYPE "ProjectManagementNotificationCategory" ADD VALUE IF NOT EXISTS 'PROJECT'`,
    );
    await client.query("BEGIN");
    if (rows.notificationPreferences.length > 0) {
      await client.query(
        `INSERT INTO "NotificationPreference"
         SELECT * FROM jsonb_populate_recordset(
           NULL::"NotificationPreference",
           $1::jsonb
         )`,
        [JSON.stringify(rows.notificationPreferences)],
      );
    }
    if (rows.inAppNotifications.length > 0) {
      await client.query(
        `INSERT INTO "InAppNotification"
         SELECT * FROM jsonb_populate_recordset(
           NULL::"InAppNotification",
           $1::jsonb
         )`,
        [JSON.stringify(rows.inAppNotifications)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function protectedTablesEqual(
  before: Record<string, BaselineTable>,
  after: Record<string, BaselineTable>,
): boolean {
  return PROTECTED_TABLE_NAMES.every(
    (table) =>
      before[table]?.rowCount === after[table]?.rowCount &&
      before[table]?.stableHash === after[table]?.stableHash,
  );
}

function assertP0Safety(report: P0BaselineReport): void {
  const safety = report.safetyChecks;
  if (
    safety.legacyEnumCount !== 0 ||
    safety.legacyTableCount !== 0 ||
    safety.progressOutboxRows !== 0 ||
    safety.projectManagerRoleRows !== 0 ||
    safety.forbiddenLegacyColumns.length !== 0
  ) {
    throw new Error("P0 release safety baseline reported a legacy finding");
  }
}

async function collectUploadManifest(root: string): Promise<UploadManifest> {
  const entries: string[] = [];
  let bytes = 0;
  let files = 0;

  async function visit(relativeDirectory: string): Promise<void> {
    const directory = path.join(root, relativeDirectory);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = path.join(relativeDirectory, child.name);
      const absolutePath = path.join(root, relativePath);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error("Upload rehearsal refuses symbolic links");
      }
      if (stats.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error("Upload rehearsal accepts regular files only");
      }
      const digest = createHash("sha256")
        .update(await readFile(absolutePath))
        .digest("hex");
      entries.push(`${relativePath.split(path.sep).join("/")}\0${stats.size}\0${digest}`);
      bytes += stats.size;
      files += 1;
    }
  }

  await visit("");
  return {
    bytes,
    files,
    stableHash: createHash("sha256").update(entries.join("\n")).digest("hex"),
  };
}

async function rehearseUploadRestore({
  sourceDirectory,
  workspace,
}: {
  sourceDirectory?: string;
  workspace: string;
}): Promise<ReleaseRehearsalReport["uploadRestore"]> {
  const source = sourceDirectory
    ? path.resolve(sourceDirectory)
    : path.join(workspace, "empty-upload-source");
  if (!sourceDirectory) await mkdir(source, { recursive: true });
  const sourceStats = await lstat(source);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error("Upload rehearsal source must be a real directory");
  }

  const backupDirectory = path.join(workspace, "upload-backup");
  const restoredDirectory = path.join(workspace, "upload-restored");
  const sourceManifest = await collectUploadManifest(source);
  await cp(source, backupDirectory, {
    errorOnExist: true,
    force: false,
    recursive: true,
  });
  const backupManifest = await collectUploadManifest(backupDirectory);
  await cp(backupDirectory, restoredDirectory, {
    errorOnExist: true,
    force: false,
    recursive: true,
  });
  const restoredManifest = await collectUploadManifest(restoredDirectory);
  const verified =
    JSON.stringify(sourceManifest) === JSON.stringify(backupManifest) &&
    JSON.stringify(sourceManifest) === JSON.stringify(restoredManifest);
  if (!verified) throw new Error("Upload volume restore manifest differs from source");
  return {
    backup: backupManifest,
    restored: restoredManifest,
    source: sourceManifest,
    verified,
  };
}

function assertInputs(input: RunReleaseRehearsalInput): ParsedDatabaseUrl {
  if (input.confirmation !== CONFIRMATION) {
    throw new Error(
      `PM_RELEASE_REHEARSAL_CONFIRM must equal ${CONFIRMATION}`,
    );
  }
  if (input.notificationDeliveryDisabled !== "true") {
    throw new Error("NOTIFICATION_DELIVERY_DISABLED=true is required");
  }
  if (input.scenario !== "empty" && input.scenario !== "shared_snapshot") {
    throw new Error("Release rehearsal scenario is invalid");
  }
  return parseSafeSourceDatabaseUrl(input.sourceDatabaseUrl);
}

export async function runProjectManagementReleaseRehearsal(
  input: RunReleaseRehearsalInput,
): Promise<ReleaseRehearsalReport> {
  const source = assertInputs(input);
  const repositoryRoot = path.resolve(input.repositoryRoot ?? process.cwd());
  const token = randomBytes(8).toString("hex");
  const workingDatabaseName = `pmrel_${token}_working_test`;
  const restoredDatabaseName = `pmrel_${token}_restored_test`;
  const workingDatabaseUrl = databaseUrlForName(source.url, workingDatabaseName);
  const restoredDatabaseUrl = databaseUrlForName(source.url, restoredDatabaseName);
  const workspace = await mkdtemp(path.join(os.tmpdir(), `pm-release-${token}-`));
  const adminClient = new pg.Client({
    connectionString: maintenanceDatabaseUrl(source.url),
  });
  let adminConnected = false;
  let databasesRemoved = false;
  let temporaryFilesRemoved = false;
  let report: ReleaseRehearsalReport | null = null;

  try {
    await adminClient.connect();
    adminConnected = true;
    await recreateDatabase(adminClient, workingDatabaseName);
    await recreateDatabase(adminClient, restoredDatabaseName);

    let beforeMigration: P0BaselineReport | null = null;
    let futureProjectNotificationRows: FutureProjectNotificationRows | null = null;
    if (input.scenario === "shared_snapshot") {
      const snapshotDump = path.join(workspace, "shared-snapshot.dump");
      dumpDatabase({
        databaseUrl: source.url.toString(),
        dumpPath: snapshotDump,
        repositoryRoot,
      });
      restoreDatabase({
        databaseUrl: workingDatabaseUrl,
        dumpPath: snapshotDump,
        repositoryRoot,
      });
      await prepareSharedSnapshotBeforeExpectedMigrations(workingDatabaseUrl);
      beforeMigration = runTsxJson<P0BaselineReport>({
        databaseUrl: workingDatabaseUrl,
        repositoryRoot,
        script: "scripts/project-management-p0-baseline.ts",
      });
      futureProjectNotificationRows = await stageFutureProjectNotificationRows(
        workingDatabaseUrl,
      );
    }

    const migrationsBefore = await listAppliedMigrations(workingDatabaseUrl);
    runCommand({
      args: ["scripts/deploy-db.ts"],
      command: path.join(repositoryRoot, "node_modules", ".bin", "tsx"),
      cwd: repositoryRoot,
      env: commandEnvironment(workingDatabaseUrl),
    });
    if (futureProjectNotificationRows) {
      await restoreFutureProjectNotificationRows(
        workingDatabaseUrl,
        futureProjectNotificationRows,
      );
    }
    const migrationsAfter = await listAppliedMigrations(workingDatabaseUrl);
    const appliedMigrations = migrationsAfter.filter(
      (migration) => !migrationsBefore.includes(migration),
    );
    const expectedMigrationsApplied = EXPECTED_REHEARSAL_MIGRATIONS.every(
      (migration) => appliedMigrations.includes(migration),
    );
    if (!expectedMigrationsApplied) {
      throw new Error(
        `Release rehearsal did not apply expected migrations: ${EXPECTED_REHEARSAL_MIGRATIONS.join(", ")}`,
      );
    }
    if (
      input.scenario === "shared_snapshot" &&
      (appliedMigrations.length !== EXPECTED_REHEARSAL_MIGRATIONS.length ||
        appliedMigrations.some(
          (migration) =>
            !EXPECTED_REHEARSAL_MIGRATIONS.includes(
              migration as (typeof EXPECTED_REHEARSAL_MIGRATIONS)[number],
            ),
        ))
    ) {
      throw new Error("Shared snapshot rehearsal applied an unexpected migration set");
    }

    const afterMigration = runTsxJson<P0BaselineReport>({
      databaseUrl: workingDatabaseUrl,
      repositoryRoot,
      script: "scripts/project-management-p0-baseline.ts",
    });
    assertP0Safety(afterMigration);
    const sharedDataUnchanged = beforeMigration
      ? protectedTablesEqual(
          beforeMigration.protectedTables,
          afterMigration.protectedTables,
        )
      : true;
    if (!sharedDataUnchanged) {
      throw new Error("Protected shared table count/hash changed during migration");
    }

    const dryRun = runTsxJson<IdentityBackfillReport>({
      databaseUrl: workingDatabaseUrl,
      repositoryRoot,
      script: "scripts/project-management-identity-backfill.ts",
    });
    if (dryRun.conflicts.length !== 0) {
      throw new Error("Identity backfill dry-run reported conflicts");
    }
    const apply = runTsxJson<IdentityBackfillReport>({
      databaseUrl: workingDatabaseUrl,
      extraEnvironment: { APPLY_PM_IDENTITY_BACKFILL: "true" },
      repositoryRoot,
      script: "scripts/project-management-identity-backfill.ts",
    });
    const repeatedApply = runTsxJson<IdentityBackfillReport>({
      databaseUrl: workingDatabaseUrl,
      extraEnvironment: { APPLY_PM_IDENTITY_BACKFILL: "true" },
      repositoryRoot,
      script: "scripts/project-management-identity-backfill.ts",
    });
    const verifiedIdempotent =
      apply.conflicts.length === 0 &&
      repeatedApply.conflicts.length === 0 &&
      repeatedApply.created === 0;
    if (!verifiedIdempotent) {
      throw new Error("Identity backfill repeated APPLY was not idempotent");
    }

    const afterBackfill = runTsxJson<P0BaselineReport>({
      databaseUrl: workingDatabaseUrl,
      repositoryRoot,
      script: "scripts/project-management-p0-baseline.ts",
    });
    if (
      !protectedTablesEqual(
        afterMigration.protectedTables,
        afterBackfill.protectedTables,
      )
    ) {
      throw new Error("Identity backfill changed protected shared tables");
    }

    const sourceManifest = await collectDatabaseManifest(workingDatabaseUrl);
    const finalDump = path.join(workspace, "full-database.dump");
    dumpDatabase({
      databaseUrl: workingDatabaseUrl,
      dumpPath: finalDump,
      repositoryRoot,
    });
    restoreDatabase({
      databaseUrl: restoredDatabaseUrl,
      dumpPath: finalDump,
      repositoryRoot,
    });
    const restoredManifest = await collectDatabaseManifest(restoredDatabaseUrl);
    const databaseRestoreVerified =
      sourceManifest.stableHash === restoredManifest.stableHash;
    if (!databaseRestoreVerified) {
      throw new Error("Restored database manifest differs from rehearsal source");
    }

    const uploadRestore = await rehearseUploadRestore({
      sourceDirectory: input.uploadSourceDirectory,
      workspace,
    });

    report = {
      businessTimezone: "Asia/Shanghai",
      cleanup: {
        rehearsalDatabasesRemoved: false,
        temporaryFilesRemoved: false,
      },
      databaseRestore: {
        source: sourceManifest,
        restored: restoredManifest,
        verified: databaseRestoreVerified,
      },
      generatedAt: new Date().toISOString(),
      identityBackfill: {
        apply,
        dryRun,
        repeatedApply,
        verifiedIdempotent,
      },
      migration: {
        appliedMigrationCount: appliedMigrations.length,
        appliedMigrations,
        beforeMigrationCount: migrationsBefore.length,
        expectedMigrationsApplied,
        protectedTablesAfter: afterMigration.protectedTables,
        protectedTablesBefore: beforeMigration?.protectedTables ?? null,
        sharedDataUnchanged,
      },
      rehearsalId: token,
      safety: {
        ...afterMigration.safetyChecks,
        notificationDeliveryDisabled: true,
        sourceDatabaseName: source.databaseName,
      },
      scenario: input.scenario,
      uploadRestore,
    };
  } finally {
    const cleanupErrors: unknown[] = [];
    if (adminConnected) {
      try {
        await dropDatabase(adminClient, restoredDatabaseName);
        await dropDatabase(adminClient, workingDatabaseName);
        databasesRemoved = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await adminClient.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(workspace, { force: true, recursive: true });
      temporaryFilesRemoved = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Release rehearsal cleanup did not complete",
      );
    }
  }
  if (!report) throw new Error("Release rehearsal did not produce a report");
  report.cleanup = {
    rehearsalDatabasesRemoved: databasesRemoved,
    temporaryFilesRemoved,
  };
  return report;
}
