import { spawn } from "node:child_process";
import path from "node:path";
import { logger, withScriptLogging } from "../lib/logger";
import { assertOfficialPlaywrightEnvironment } from "./playwright-runner";

function runStep(
  command: string,
  args: string[],
  extraEnv?: Record<string, string | undefined>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        NO_COLOR: undefined,
        FORCE_COLOR: undefined,
        CONFIRM_SEND_FEISHU: "",
        CHECKPOINT_DISABLE: "1",
        NOTIFICATION_DELIVERY_DISABLED: "true",
        ...extraEnv,
      },
      stdio: "inherit",
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 1}`));
    });
    child.once("error", reject);
  });
}

async function main(): Promise<void> {
  const ownership = assertOfficialPlaywrightEnvironment(process.env);
  const port = process.env.PLAYWRIGHT_SERVER_PORT;
  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const nextBin = path.join(
    process.cwd(),
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  logger.info("playwright.server.start", {
    module: "playwright",
    action: "startPlaywrightServer",
    port,
    targetDatabaseName: ownership.target.databaseName,
    shadowDatabaseName: ownership.shadow.databaseName,
    checkpointDisabled: true,
    notificationDeliveryDisabled: true,
  });

  await runStep(process.execPath, [tsxBin, "scripts/setup-playwright-db.ts"]);
  await runStep(npmCommand, ["run", "db:deploy"]);
  await runStep(npmCommand, ["run", "db:seed"]);
  await runStep(
    process.execPath,
    [nextBin, "dev", "-H", "127.0.0.1", "-p", port ?? ""],
    { PORT: port },
  );
}

withScriptLogging("start-playwright-server", main).catch((error) => {
  logger.error("playwright.server.failed", {
    module: "playwright",
    action: "startPlaywrightServer",
    error,
  });
  process.exitCode = 1;
});
