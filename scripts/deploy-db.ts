import "dotenv/config";
import { existsSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";

const INITIAL_MIGRATION = "20260625160000_init";
const passthroughArgs = process.argv.slice(2);

function resolveSqlitePath(): string {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  const raw = url.replace(/^file:/, "");
  if (path.isAbsolute(raw)) return raw;
  return path.join(process.cwd(), raw.replace(/^\.\//, ""));
}

function runPrisma(args: string[]) {
  const result = spawnSync("npx", ["prisma", ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName);
  return !!row;
}

function shouldBaselineExistingSqlite(): boolean {
  const dbPath = resolveSqlitePath();
  if (!existsSync(dbPath)) return false;

  const db = new Database(dbPath, { readonly: true });
  try {
    const hasMigrationTable = tableExists(db, "_prisma_migrations");
    const hasApplicationTables =
      tableExists(db, "User") && tableExists(db, "PurchaseOrder");
    return hasApplicationTables && !hasMigrationTable;
  } finally {
    db.close();
  }
}

if (passthroughArgs.length > 0) {
  runPrisma(["migrate", "deploy", ...passthroughArgs]);
  process.exit(0);
}

if (shouldBaselineExistingSqlite()) {
  console.log(
    `[db:deploy] existing SQLite schema detected; baselining ${INITIAL_MIGRATION}`,
  );
  runPrisma(["migrate", "resolve", "--applied", INITIAL_MIGRATION]);
}

runPrisma(["migrate", "deploy"]);
