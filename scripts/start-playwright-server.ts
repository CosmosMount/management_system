import { spawn } from "child_process";
import path from "path";
import { logger, withScriptLogging } from "../lib/logger";

const databaseUrl = process.env.PLAYWRIGHT_DATABASE_URL;
const port = process.env.PLAYWRIGHT_SERVER_PORT ?? "3002";

if (!databaseUrl) {
  throw new Error("PLAYWRIGHT_DATABASE_URL is required");
}

const targetDatabase = new URL(databaseUrl).pathname.replace(/^\//, "");
if (!targetDatabase.endsWith("_test")) {
  throw new Error("PLAYWRIGHT_DATABASE_URL must point to a database ending with _test");
}

function runStep(
  command: string,
  args: string[],
  extraEnv?: Record<string, string | undefined>,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        NO_COLOR: undefined,
        FORCE_COLOR: undefined,
        DATABASE_URL: databaseUrl,
        PLAYWRIGHT_DATABASE_URL: databaseUrl,
        PLAYWRIGHT_CONFIRM_RECREATE_DB: targetDatabase,
        NOTIFICATION_DELIVERY_DISABLED: "true",
        FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES:
          process.env.FEISHU_DIRECT_MESSAGE_ALLOWED_NAMES?.trim() || "李棋轩",
        ...extraEnv,
      },
      stdio: "inherit",
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited with signal ${signal}`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function main() {
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  logger.info("playwright.server.start", {
    module: "playwright",
    action: "startPlaywrightServer",
    port,
    databaseName: targetDatabase,
    isTestDatabase: targetDatabase.endsWith("_test"),
    notificationDeliveryDisabled: true,
  });

  await runStep(process.execPath, [tsxBin, "scripts/setup-playwright-db.ts"]);
  await runStep(npmCommand, ["run", "db:deploy"]);
  if (process.env.PLAYWRIGHT_DB_SETUP_MODE === "clone") {
    await runStep(process.execPath, [tsxBin, "scripts/copy-playwright-db-data.ts"]);
  }
  await runStep(npmCommand, ["run", "db:seed"]);
  await runStep(npmCommand, ["run", "db:seed-acceptance-checklists"]);
  await runStep(npmCommand, ["run", "db:seed-progress-reminders"]);

  await runStep(npmCommand, ["run", "dev", "--", "-p", port], {
    PORT: port,
  });
}

withScriptLogging("start-playwright-server", main).catch((error) => {
  logger.error("playwright.server.failed", {
    module: "playwright",
    action: "startPlaywrightServer",
    port,
    databaseName: targetDatabase,
    error,
  });
  process.exit(1);
});
