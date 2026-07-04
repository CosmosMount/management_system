import "dotenv/config";
import { spawn } from "node:child_process";
import pg from "pg";
import { logger, withScriptLogging } from "../lib/logger";

const databaseUrl = process.env.PLAYWRIGHT_DATABASE_URL;
const setupMode = process.env.PLAYWRIGHT_DB_SETUP_MODE ?? "recreate";

if (!databaseUrl) {
  throw new Error("PLAYWRIGHT_DATABASE_URL is required");
}

const targetDatabaseUrl = databaseUrl;
const targetUrl = new URL(targetDatabaseUrl);
const targetDatabase = targetUrl.pathname.replace(/^\//, "");

if (!targetDatabase) {
  throw new Error("PLAYWRIGHT_DATABASE_URL must include a database name");
}

if (!targetDatabase.endsWith("_test")) {
  throw new Error("PLAYWRIGHT_DATABASE_URL must point to a database ending with _test");
}

if (process.env.PLAYWRIGHT_CONFIRM_RECREATE_DB !== targetDatabase) {
  throw new Error(
    `Refusing to recreate ${targetDatabase}. Set PLAYWRIGHT_CONFIRM_RECREATE_DB=${targetDatabase} to confirm.`,
  );
}

const maintenanceUrl = new URL(targetDatabaseUrl);
maintenanceUrl.pathname = "/postgres";

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function recreateDatabase(databaseName: string) {
  const client = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    logger.info("playwright.db.recreated", {
      module: "playwright",
      action: "recreateDatabase",
      databaseName,
      isTestDatabase: databaseName.endsWith("_test"),
    });
  } finally {
    await client.end();
  }
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function sameDatabaseUrl(left: string, right: string): boolean {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  leftUrl.search = "";
  rightUrl.search = "";
  return leftUrl.toString() === rightUrl.toString();
}

function assertSamePostgresServer(sourceDatabaseUrl: string) {
  const sourceUrl = new URL(sourceDatabaseUrl);
  const targetUrlForCompare = new URL(targetDatabaseUrl);
  const sameServer =
    sourceUrl.protocol === targetUrlForCompare.protocol &&
    sourceUrl.hostname === targetUrlForCompare.hostname &&
    (sourceUrl.port || "5432") === (targetUrlForCompare.port || "5432") &&
    sourceUrl.username === targetUrlForCompare.username;

  if (!sameServer) {
    throw new Error(
      "PLAYWRIGHT_DB_SETUP_MODE=clone without pg_dump requires source and target on the same PostgreSQL server with the same user",
    );
  }
}

async function assertSafeCloneTarget(sourceDatabaseUrl: string) {
  const sourceDatabase = new URL(sourceDatabaseUrl).pathname.replace(/^\//, "");
  if (!sourceDatabase) {
    throw new Error("PLAYWRIGHT_SOURCE_DATABASE_URL must include a database name");
  }
  if (sourceDatabase === targetDatabase) {
    throw new Error("Refusing to clone because source and target database names match");
  }

  const source = new pg.Client({ connectionString: sourceDatabaseUrl });
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await source.connect();
  await maintenance.connect();
  try {
    const [sourceIdentity, maintenanceIdentity] = await Promise.all([
      getConnectionIdentity(source),
      getConnectionIdentity(maintenance),
    ]);
    const sameServer =
      sourceIdentity.serverAddress === maintenanceIdentity.serverAddress &&
      sourceIdentity.serverPort === maintenanceIdentity.serverPort &&
      sourceIdentity.systemIdentifier === maintenanceIdentity.systemIdentifier;
    if (sameServer && sourceIdentity.databaseName === targetDatabase) {
      throw new Error(
        "Refusing to clone because source and target resolve to the same database on the same PostgreSQL server",
      );
    }
  } finally {
    await source.end();
    await maintenance.end();
  }
}

async function getConnectionIdentity(client: pg.Client) {
  const result = await client.query<{
    database_name: string;
    server_address: string | null;
    server_port: number;
    system_identifier: string;
  }>(
    `
      SELECT
        current_database() AS database_name,
        inet_server_addr()::text AS server_address,
        inet_server_port() AS server_port,
        system_identifier::text
      FROM pg_control_system()
    `,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Unable to read PostgreSQL connection identity");
  return {
    databaseName: row.database_name,
    serverAddress: row.server_address ?? "",
    serverPort: row.server_port,
    systemIdentifier: row.system_identifier,
  };
}

function pipeDumpToRestore(sourceDatabaseUrl: string, targetDatabaseUrl: string) {
  return new Promise<void>((resolve, reject) => {
    const dump = spawn(
      "pg_dump",
      [
        "--no-owner",
        "--no-privileges",
        "--format=custom",
        '--exclude-table-data=public."NotificationOutbox"',
        '--exclude-table-data=public."NotificationOutboxRecipient"',
        `--dbname=${sourceDatabaseUrl}`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const restore = spawn(
      "pg_restore",
      [
        "--no-owner",
        "--no-privileges",
        "--dbname",
        targetDatabaseUrl,
        "--single-transaction",
        "--exit-on-error",
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );

    dump.stdout.pipe(restore.stdin);

    let dumpExited = false;
    let restoreExited = false;
    let rejected = false;

    function fail(error: Error) {
      if (rejected) return;
      rejected = true;
      reject(error);
    }

    function maybeResolve() {
      if (!rejected && dumpExited && restoreExited) resolve();
    }

    dump.on("exit", (code, signal) => {
      if (signal) {
        fail(new Error(`pg_dump exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        fail(new Error(`pg_dump exited with code ${code ?? 1}`));
        return;
      }
      dumpExited = true;
      maybeResolve();
    });
    restore.on("exit", (code, signal) => {
      if (signal) {
        fail(new Error(`pg_restore exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        fail(new Error(`pg_restore exited with code ${code ?? 1}`));
        return;
      }
      restoreExited = true;
      maybeResolve();
    });
    dump.on("error", fail);
    restore.on("error", fail);
  });
}

async function clearRestoredNotificationOutbox() {
  const client = new pg.Client({ connectionString: targetDatabaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ table_name: string | null }>(
      `SELECT to_regclass('public."NotificationOutbox"')::text AS table_name`,
    );
    if (!result.rows[0]?.table_name) return;
    await client.query('TRUNCATE TABLE "NotificationOutbox" CASCADE');
    logger.info("playwright.db.notification_outbox_cleared", {
      module: "playwright",
      action: "clearRestoredNotificationOutbox",
      databaseName: targetDatabase,
    });
  } finally {
    await client.end();
  }
}

async function cloneDatabase(sourceDatabaseUrl: string) {
  const hasPgDump = await commandExists("pg_dump");
  const hasPgRestore = await commandExists("pg_restore");
  if (hasPgDump && hasPgRestore) {
    await recreateDatabase(targetDatabase);
    await pipeDumpToRestore(sourceDatabaseUrl, targetDatabaseUrl);
    await clearRestoredNotificationOutbox();
    logger.info("playwright.db.cloned", {
      module: "playwright",
      action: "cloneDatabase",
      databaseName: targetDatabase,
      usedPgDump: true,
    });
    return;
  }

  assertSamePostgresServer(sourceDatabaseUrl);
  await recreateDatabase(targetDatabase);
  logger.warn("playwright.db.clone_without_pg_dump", {
    module: "playwright",
    action: "cloneDatabase",
    databaseName: targetDatabase,
    usedPgDump: false,
  });
}

async function main() {
  logger.info("playwright.db.setup.start", {
    module: "playwright",
    action: "setupPlaywrightDb",
    setupMode,
    databaseName: targetDatabase,
    isTestDatabase: targetDatabase.endsWith("_test"),
    notificationDeliveryDisabled:
      process.env.NOTIFICATION_DELIVERY_DISABLED === "true",
  });
  if (setupMode === "clone") {
    const sourceDatabaseUrl = process.env.PLAYWRIGHT_SOURCE_DATABASE_URL;
    if (!sourceDatabaseUrl) {
      throw new Error(
        "PLAYWRIGHT_SOURCE_DATABASE_URL is required when PLAYWRIGHT_DB_SETUP_MODE=clone",
      );
    }
    if (sameDatabaseUrl(sourceDatabaseUrl, targetDatabaseUrl)) {
      throw new Error("Refusing to clone because source and target DATABASE_URL are identical");
    }
    await assertSafeCloneTarget(sourceDatabaseUrl);
    await cloneDatabase(sourceDatabaseUrl);
    return;
  }
  if (setupMode !== "recreate") {
    throw new Error(`Unsupported PLAYWRIGHT_DB_SETUP_MODE: ${setupMode}`);
  }
  await recreateDatabase(targetDatabase);
  await recreateDatabase(`${targetDatabase}_shadow`);
}

withScriptLogging("setup-playwright-db", main).catch((error) => {
  logger.error("playwright.db.setup.failed", {
    module: "playwright",
    action: "setupPlaywrightDb",
    databaseName: targetDatabase,
    error,
  });
  process.exit(1);
});
