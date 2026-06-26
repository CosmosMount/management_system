import "dotenv/config";
import { spawnSync } from "child_process";

const passthroughArgs = process.argv.slice(2);
const maxWaitMs = Number(process.env.DB_WAIT_MS ?? 60_000);
const pollMs = 2_000;

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
    runPrisma(["migrate", "deploy", ...passthroughArgs]);
    return;
  }

  runPrisma(["migrate", "deploy"]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
