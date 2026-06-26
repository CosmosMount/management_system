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

const maintenanceUrl = new URL(databaseUrl);
maintenanceUrl.pathname = "/postgres";

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function ensureDatabase(databaseName: string) {
  const client = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();
  try {
    const existing = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [databaseName],
    );
    if (!existing.rows[0]?.exists) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      console.log(`[playwright-db] created database ${databaseName}`);
    } else {
      console.log(`[playwright-db] database ${databaseName} already exists`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  await ensureDatabase(targetDatabase);
  await ensureDatabase(`${targetDatabase}_shadow`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
