import { spawn } from "child_process";
import { randomUUID } from "node:crypto";
import path from "path";
import { logger } from "../lib/logger";
import {
  PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL,
  PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_RUN_ID_ENV,
  withPlaywrightFeishuEgressGuardNodeOptions,
} from "./playwright-feishu-egress-guard.mjs";

const env = { ...process.env };
delete env.NO_COLOR;
delete env.FORCE_COLOR;
env.CHECKPOINT_DISABLE = "1";
env.NOTIFICATION_DELIVERY_DISABLED = "true";
env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV] = "true";
env[PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS_ENV] =
  env.NODE_OPTIONS?.trim() ?? "";
env[PLAYWRIGHT_FEISHU_EGRESS_RUN_ID_ENV] = randomUUID();
if (
  !(env.NODE_OPTIONS ?? "")
    .split(/\s+/)
    .includes(PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL)
) {
  env.NODE_OPTIONS = [
    env.NODE_OPTIONS?.trim(),
    PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL,
  ]
    .filter(Boolean)
    .join(" ");
}
env.NODE_OPTIONS = withPlaywrightFeishuEgressGuardNodeOptions(
  env.NODE_OPTIONS,
  path.join(process.cwd(), "scripts", "playwright-feishu-egress-guard.mjs"),
);

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
  checkpointDisabled: env.CHECKPOINT_DISABLE === "1",
  notificationDeliveryDisabled: env.NOTIFICATION_DELIVERY_DISABLED === "true",
  feishuEgressDisabled:
    env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV] === "true",
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
