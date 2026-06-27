import "dotenv/config";
import pg from "pg";

const databaseUrl = process.env.PLAYWRIGHT_DATABASE_URL;

if (!databaseUrl) {
  throw new Error("PLAYWRIGHT_DATABASE_URL is required");
}

const targetUrl = new URL(databaseUrl);
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

const maintenanceUrl = new URL(databaseUrl);
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
    console.log(`[playwright-db] recreated database ${databaseName}`);
  } finally {
    await client.end();
  }
}

async function main() {
  await recreateDatabase(targetDatabase);
  await recreateDatabase(`${targetDatabase}_shadow`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
