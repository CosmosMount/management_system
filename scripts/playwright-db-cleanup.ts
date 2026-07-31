import pg from "pg";
import { logger } from "../lib/logger";
import {
  removePlaywrightOwnershipMarker,
  resolvePlaywrightOwnershipMarker,
  type PlaywrightOwnershipMarker,
} from "./playwright-db-ownership-marker";
import {
  assertPlaywrightMaintenanceConnection,
  maintenanceDatabaseUrl,
  resolvePlaywrightDatabaseOwnership,
  type PlaywrightDatabaseEnvironment,
  type PlaywrightDatabaseOwnership,
} from "./playwright-db-safety";

export function quotePlaywrightDatabaseIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function withMaintenanceClient<T>(
  ownership: PlaywrightDatabaseOwnership,
  operation: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    connectionString: maintenanceDatabaseUrl(ownership.target.url),
  });
  let operationResult: T | undefined;
  let operationError: unknown;
  try {
    await client.connect();
    await assertPlaywrightMaintenanceConnection(client, ownership.target);
    operationResult = await operation(client);
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  try {
    await client.end();
  } catch (error) {
    closeError = error;
  }
  if (operationError && closeError) {
    throw new AggregateError(
      [operationError, closeError],
      "Playwright maintenance operation and connection close both failed",
    );
  }
  if (operationError) throw operationError;
  if (closeError) throw closeError;
  return operationResult as T;
}

async function dropExactDatabase(
  client: pg.Client,
  databaseName: string,
): Promise<void> {
  await client.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [databaseName],
  );
  await client.query(
    `DROP DATABASE IF EXISTS ${quotePlaywrightDatabaseIdentifier(databaseName)}`,
  );
  logger.info("playwright.db.dropped", {
    module: "playwright",
    action: "dropExactDatabase",
    databaseName,
  });
}

export async function dropExactPlaywrightDatabases(
  ownership: PlaywrightDatabaseOwnership,
): Promise<void> {
  await withMaintenanceClient(ownership, async (client) => {
    const dropErrors: unknown[] = [];
    for (const databaseName of [
      ownership.shadow.databaseName,
      ownership.target.databaseName,
    ]) {
      try {
        await dropExactDatabase(client, databaseName);
      } catch (error) {
        dropErrors.push(error);
      }
    }
    if (dropErrors.length > 0) {
      throw new AggregateError(
        dropErrors,
        "Failed to drop one or more exact runner-owned Playwright databases",
      );
    }
  });
}

async function exactPlaywrightDatabasesAreAbsent(
  ownership: PlaywrightDatabaseOwnership,
): Promise<boolean> {
  return withMaintenanceClient(ownership, async (client) => {
    const result = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = ANY($1::text[])",
      [[ownership.target.databaseName, ownership.shadow.databaseName]],
    );
    return result.rowCount === 0;
  });
}

async function recreateExactDatabase(
  ownership: PlaywrightDatabaseOwnership,
  databaseName: string,
): Promise<void> {
  await withMaintenanceClient(ownership, async (client) => {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await client.query(
      `DROP DATABASE IF EXISTS ${quotePlaywrightDatabaseIdentifier(databaseName)}`,
    );
    await client.query(
      `CREATE DATABASE ${quotePlaywrightDatabaseIdentifier(databaseName)}`,
    );
  });
  logger.info("playwright.db.recreated", {
    module: "playwright",
    action: "recreateExactDatabase",
    databaseName,
  });
}

export type PlaywrightDatabaseCleanupDependencies = {
  databasesAreAbsent(
    ownership: PlaywrightDatabaseOwnership,
  ): Promise<boolean>;
  dropDatabases(ownership: PlaywrightDatabaseOwnership): Promise<void>;
  removeMarker(
    cwd: string,
    ownership: PlaywrightDatabaseOwnership,
    env: PlaywrightDatabaseEnvironment,
    expectedMarker: PlaywrightOwnershipMarker,
  ): void;
  resolveMarker(
    cwd: string,
    ownership: PlaywrightDatabaseOwnership,
    env: PlaywrightDatabaseEnvironment,
  ): PlaywrightOwnershipMarker;
};

export const defaultPlaywrightDatabaseCleanupDependencies: PlaywrightDatabaseCleanupDependencies = {
  databasesAreAbsent: exactPlaywrightDatabasesAreAbsent,
  dropDatabases: dropExactPlaywrightDatabases,
  removeMarker: removePlaywrightOwnershipMarker,
  resolveMarker: resolvePlaywrightOwnershipMarker,
};

export async function cleanupPlaywrightDatabaseOwnership(
  ownership: PlaywrightDatabaseOwnership,
  env: PlaywrightDatabaseEnvironment,
  cwd = process.cwd(),
  options: {
    allowAlreadyFinalized?: boolean;
    expectedMarker?: PlaywrightOwnershipMarker;
  } = {},
  dependencies = defaultPlaywrightDatabaseCleanupDependencies,
): Promise<void> {
  const validatedOwnership = resolvePlaywrightDatabaseOwnership({
    PLAYWRIGHT_DATABASE_URL: ownership.target.url,
    PLAYWRIGHT_DB_OWNERSHIP_TOKEN: ownership.token,
    PLAYWRIGHT_SHADOW_DATABASE_URL: ownership.shadow.url,
  });

  let marker: PlaywrightOwnershipMarker;
  try {
    marker = dependencies.resolveMarker(cwd, validatedOwnership, env);
  } catch (error) {
    const markerMissing = (error as NodeJS.ErrnoException).code === "ENOENT";
    const expectedMarkerMatchesEnvironment =
      options.expectedMarker?.markerPath ===
        env.PLAYWRIGHT_DB_OWNERSHIP_MARKER &&
      options.expectedMarker?.secret === env.PLAYWRIGHT_DB_OWNERSHIP_SECRET;
    if (
      !options.allowAlreadyFinalized ||
      !markerMissing ||
      !expectedMarkerMatchesEnvironment
    ) {
      throw error;
    }
    if (await dependencies.databasesAreAbsent(validatedOwnership)) return;
    throw new Error(
      "The ownership marker is absent while a runner-owned Playwright database still exists",
    );
  }

  if (
    options.expectedMarker &&
    (marker.markerPath !== options.expectedMarker.markerPath ||
      marker.device !== options.expectedMarker.device ||
      marker.inode !== options.expectedMarker.inode)
  ) {
    throw new Error("The Playwright ownership marker changed before cleanup");
  }

  await dependencies.dropDatabases(validatedOwnership);
  dependencies.removeMarker(cwd, validatedOwnership, env, marker);
}

export type PlaywrightDatabaseSetupDependencies = {
  cleanup(
    ownership: PlaywrightDatabaseOwnership,
    env: PlaywrightDatabaseEnvironment,
    cwd: string,
    expectedMarker: PlaywrightOwnershipMarker,
  ): Promise<void>;
  recreateDatabase(
    ownership: PlaywrightDatabaseOwnership,
    databaseName: string,
  ): Promise<void>;
  resolveMarker(
    cwd: string,
    ownership: PlaywrightDatabaseOwnership,
    env: PlaywrightDatabaseEnvironment,
  ): PlaywrightOwnershipMarker;
};

export const defaultPlaywrightDatabaseSetupDependencies: PlaywrightDatabaseSetupDependencies = {
  cleanup: (ownership, env, cwd, expectedMarker) =>
    cleanupPlaywrightDatabaseOwnership(ownership, env, cwd, {
      expectedMarker,
    }),
  recreateDatabase: recreateExactDatabase,
  resolveMarker: resolvePlaywrightOwnershipMarker,
};

export async function setupPlaywrightDatabaseOwnership(
  ownership: PlaywrightDatabaseOwnership,
  env: PlaywrightDatabaseEnvironment,
  cwd = process.cwd(),
  dependencies = defaultPlaywrightDatabaseSetupDependencies,
): Promise<void> {
  const marker = dependencies.resolveMarker(cwd, ownership, env);
  try {
    await dependencies.recreateDatabase(
      ownership,
      ownership.target.databaseName,
    );
    await dependencies.recreateDatabase(
      ownership,
      ownership.shadow.databaseName,
    );
  } catch (setupError) {
    try {
      await dependencies.cleanup(ownership, env, cwd, marker);
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        "Playwright database setup failed and exact compensation was incomplete",
      );
    }
    throw setupError;
  }
}
