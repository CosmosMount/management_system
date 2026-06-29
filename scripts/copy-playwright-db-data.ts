import "dotenv/config";
import pg from "pg";

const sourceDatabaseUrl = process.env.PLAYWRIGHT_SOURCE_DATABASE_URL;
const targetDatabaseUrl = process.env.PLAYWRIGHT_DATABASE_URL;

if (!sourceDatabaseUrl) {
  throw new Error("PLAYWRIGHT_SOURCE_DATABASE_URL is required");
}
if (!targetDatabaseUrl) {
  throw new Error("PLAYWRIGHT_DATABASE_URL is required");
}

const targetDatabase = new URL(targetDatabaseUrl).pathname.replace(/^\//, "");
if (!targetDatabase.endsWith("_test")) {
  throw new Error("PLAYWRIGHT_DATABASE_URL must point to a database ending with _test");
}

if (sameDatabaseUrl(sourceDatabaseUrl, targetDatabaseUrl)) {
  throw new Error("Refusing to copy because source and target DATABASE_URL are identical");
}

const BATCH_SIZE = 100;
const EXCLUDED_TABLES = new Set(["_prisma_migrations", "NotificationOutbox"]);
const TABLES_TO_CLEAR_ONLY = ["NotificationOutbox"];

function sameDatabaseUrl(left: string, right: string): boolean {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  leftUrl.search = "";
  rightUrl.search = "";
  return leftUrl.toString() === rightUrl.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function loadTableNames(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `,
  );
  return result.rows
    .map((row) => row.table_name)
    .filter((tableName) => !EXCLUDED_TABLES.has(tableName));
}

async function loadExistingTables(
  client: pg.Client,
  tableNames: string[],
): Promise<string[]> {
  if (tableNames.length === 0) return [];
  const result = await client.query<{ table_name: string }>(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name = ANY($1::text[])
      ORDER BY table_name
    `,
    [tableNames],
  );
  return result.rows.map((row) => row.table_name);
}

async function loadColumnNames(client: pg.Client, tableName: string): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

async function copyTable({
  source,
  target,
  tableName,
  columns,
}: {
  source: pg.Client;
  target: pg.Client;
  tableName: string;
  columns: string[];
}) {
  if (columns.length === 0) return 0;

  const tableSql = quoteIdentifier(tableName);
  const columnSql = columns.map(quoteIdentifier).join(", ");
  const sourceRows = await source.query<Record<string, unknown>>(
    `SELECT ${columnSql} FROM ${tableSql}`,
  );
  if (sourceRows.rowCount === 0) return 0;

  for (let start = 0; start < sourceRows.rows.length; start += BATCH_SIZE) {
    const rows = sourceRows.rows.slice(start, start + BATCH_SIZE);
    const values: unknown[] = [];
    const rowPlaceholders = rows.map((row, rowIndex) => {
      const placeholders = columns.map((column, columnIndex) => {
        values.push(row[column]);
        return `$${rowIndex * columns.length + columnIndex + 1}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    await target.query(
      `INSERT INTO ${tableSql} (${columnSql}) VALUES ${rowPlaceholders.join(", ")}`,
      values,
    );
  }

  return sourceRows.rowCount ?? sourceRows.rows.length;
}

async function main() {
  const source = new pg.Client({ connectionString: sourceDatabaseUrl });
  const target = new pg.Client({ connectionString: targetDatabaseUrl });
  await source.connect();
  await target.connect();

  try {
    await assertDifferentPhysicalDatabases(source, target);
    const tableNames = await loadTableNames(source);
    if (tableNames.length === 0) {
      console.log("[playwright-db] source database has no public data tables");
      return;
    }

    await target.query("BEGIN");
    await target.query("SET session_replication_role = replica");
    try {
      const clearOnlyTables = await loadExistingTables(target, TABLES_TO_CLEAR_ONLY);
      const tablesToTruncate = [...tableNames, ...clearOnlyTables];
      if (tablesToTruncate.length > 0) {
        await target.query(
          `TRUNCATE TABLE ${tablesToTruncate.map(quoteIdentifier).join(", ")} CASCADE`,
        );
      }

      let copiedRows = 0;
      for (const tableName of tableNames) {
        const columns = await loadColumnNames(source, tableName);
        const tableRows = await copyTable({ source, target, tableName, columns });
        copiedRows += tableRows;
        console.log(`[playwright-db] copied ${tableRows} rows from ${tableName}`);
      }

      await target.query("SET session_replication_role = origin");
      await target.query("COMMIT");
      console.log(
        `[playwright-db] copied ${copiedRows} rows into ${targetDatabase}`,
      );
    } catch (error) {
      await target.query("ROLLBACK");
      throw error;
    }
  } finally {
    await source.end();
    await target.end();
  }
}

async function assertDifferentPhysicalDatabases(
  source: pg.Client,
  target: pg.Client,
) {
  const [sourceIdentity, targetIdentity] = await Promise.all([
    getDatabaseIdentity(source),
    getDatabaseIdentity(target),
  ]);
  if (
    sourceIdentity.databaseName === targetIdentity.databaseName &&
    sourceIdentity.databaseOid === targetIdentity.databaseOid &&
    sourceIdentity.serverAddress === targetIdentity.serverAddress &&
    sourceIdentity.serverPort === targetIdentity.serverPort
  ) {
    throw new Error(
      "Refusing to copy because source and target resolve to the same physical database",
    );
  }
}

async function getDatabaseIdentity(client: pg.Client) {
  const result = await client.query<{
    database_name: string;
    database_oid: string;
    server_address: string | null;
    server_port: number;
  }>(
    `
      SELECT
        current_database() AS database_name,
        (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
        inet_server_addr()::text AS server_address,
        inet_server_port() AS server_port
    `,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Unable to read PostgreSQL database identity");
  return {
    databaseName: row.database_name,
    databaseOid: row.database_oid,
    serverAddress: row.server_address ?? "",
    serverPort: row.server_port,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
