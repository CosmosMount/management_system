import { spawn } from "child_process";
import path from "path";
import { logger } from "../lib/logger";

const env = { ...process.env };
delete env.NO_COLOR;
delete env.FORCE_COLOR;
env.NOTIFICATION_DELIVERY_DISABLED = "true";

const playwrightCli = path.join(
  process.cwd(),
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);

const child = spawn(process.execPath, [playwrightCli, "test", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});
logger.info("playwright.run.start", {
  module: "playwright",
  action: "runPlaywright",
  notificationDeliveryDisabled: env.NOTIFICATION_DELIVERY_DISABLED === "true",
  baseUrl: env.PLAYWRIGHT_BASE_URL,
  databaseConfigured: Boolean(env.PLAYWRIGHT_DATABASE_URL || env.DATABASE_URL),
});

child.on("exit", (code, signal) => {
  logger.info("playwright.run.exit", {
    module: "playwright",
    action: "runPlaywright",
    exitCode: code,
    signal,
    result: code === 0 ? "success" : "failure",
  });
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  logger.error("playwright.run.failed", {
    module: "playwright",
    action: "runPlaywright",
    error,
  });
  process.exit(1);
});
