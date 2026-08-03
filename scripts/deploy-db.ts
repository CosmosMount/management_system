import "dotenv/config";
import { spawnSync } from "child_process";
import { ensureTaskAccessMigrationAppliedAtomically } from "./task-access-atomic-deploy";

const passthroughArgs = process.argv.slice(2);
const maxWaitMs = Number(process.env.DB_WAIT_MS ?? 60_000);
const pollMs = 2_000;

function runPrisma(args: string[], allowFailure = false) {
  const result = spawnSync("npx", ["prisma", ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0 && !allowFailure) {
    process.exit(result.status ?? 1);
  }
  return { status: result.status };
}

async function waitForPostgres(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgresql://") && !url.startsWith("postgres://")) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string");
  }

  const { default: pg } = await import("pg");
  const started = Date.now();

  while (Date.now() - started < maxWaitMs) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.end();
      console.log("[db:deploy] PostgreSQL is ready");
      return;
    } catch {
      await client.end().catch(() => undefined);
      console.log("[db:deploy] waiting for PostgreSQL...");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  throw new Error(`PostgreSQL not ready after ${maxWaitMs}ms`);
}

async function main() {
  await waitForPostgres();
  if (passthroughArgs.length > 0) {
    throw new Error(
      "db:deploy 不接受 Prisma 透传参数；Task access 原子迁移必须经过受控部署入口",
    );
  }

  await ensureTaskAccessMigrationAppliedAtomically({
    cwd: process.cwd(),
    databaseUrl: process.env.DATABASE_URL ?? "",
    runPrisma,
  });
  runPrisma(["migrate", "deploy"]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
