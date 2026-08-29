import path from "node:path";
import {
  PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_GUARD_PATH_ENV,
  PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL,
  withPlaywrightFeishuEgressGuardNodeOptions,
} from "./playwright-feishu-egress-guard.mjs";

const DATABASE_ENVIRONMENTS = [
  "DATABASE_URL",
  "PLAYWRIGHT_DATABASE_URL",
  "SHADOW_DATABASE_URL",
  "PLAYWRIGHT_SHADOW_DATABASE_URL",
  "PLAYWRIGHT_SOURCE_DATABASE_URL",
] as const;

const EXACT_UNTRUSTED_ENVIRONMENTS = new Set([
  ...DATABASE_ENVIRONMENTS,
  "CHECKPOINT_DISABLE",
  "CONFIRM_SEND_FEISHU",
  "EMAIL_DELIVERY_ALLOWED_ADDRESSES",
  "NODE_OPTIONS",
  "NOTIFICATION_DELIVERY_DISABLED",
]);

const UNTRUSTED_ENVIRONMENT_PREFIXES = [
  "PLAYWRIGHT_",
  "DOTENV_CONFIG",
  "SMTP",
];

export function controlledNodeTestEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  cwd: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...sourceEnv };
  for (const name of Object.keys(sourceEnv)) {
    const normalizedName = name.toUpperCase();
    if (
      EXACT_UNTRUSTED_ENVIRONMENTS.has(normalizedName) ||
      UNTRUSTED_ENVIRONMENT_PREFIXES.some((prefix) =>
        normalizedName.startsWith(prefix),
      )
    ) {
      delete env[name];
    }
  }

  // Keep these names defined so a later `dotenv/config` import cannot refill
  // them from the repository .env and give a plain Node test database access.
  for (const name of DATABASE_ENVIRONMENTS) env[name] = "";

  const guardPath = path.resolve(
    cwd,
    "scripts",
    "playwright-feishu-egress-guard.mjs",
  );
  env.CHECKPOINT_DISABLE = "1";
  env.CONFIRM_SEND_FEISHU = "";
  env.NOTIFICATION_DELIVERY_DISABLED = "true";
  env.EMAIL_DELIVERY_ALLOWED_ADDRESSES = "";
  env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_ENV] = "true";
  env[PLAYWRIGHT_FEISHU_EGRESS_GUARD_PATH_ENV] = guardPath;
  env.NODE_OPTIONS = [
    PLAYWRIGHT_FEISHU_EGRESS_NODE_OPTIONS_SENTINEL,
    withPlaywrightFeishuEgressGuardNodeOptions("", guardPath),
  ].join(" ");
  return env;
}

export function nodeTestSignalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

export function finalizeNodeTestSignal(
  signal: NodeJS.Signals,
  retriggerSignal: (signal: NodeJS.Signals) => void = (value) =>
    process.kill(process.pid, value),
): void {
  process.exitCode = nodeTestSignalExitCode(signal);
  retriggerSignal(signal);
}
