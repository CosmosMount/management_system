import "dotenv/config";
import { logger, withScriptLogging } from "../lib/logger";
import { cleanupPlaywrightDatabaseOwnership } from "./playwright-db-cleanup";
import { logPlaywrightErrorCauses } from "./playwright-error-reporting";
import {
  assertPlaywrightDatabaseConfirmations,
  assertPlaywrightRecreateOnlyEnvironment,
  resolvePlaywrightDatabaseOwnership,
} from "./playwright-db-safety";

async function main(): Promise<void> {
  assertPlaywrightRecreateOnlyEnvironment(process.env);
  const ownership = resolvePlaywrightDatabaseOwnership(process.env);
  assertPlaywrightDatabaseConfirmations(ownership, process.env);
  await cleanupPlaywrightDatabaseOwnership(ownership, process.env);
}

withScriptLogging("cleanup-playwright-db", main).catch((error) => {
  logger.error("playwright.db.cleanup.failed", {
    module: "playwright",
    action: "cleanupPlaywrightDb",
    error,
  });
  logPlaywrightErrorCauses("playwright.db.cleanup.failure_cause", error, {
    module: "playwright",
    action: "cleanupPlaywrightDb",
  });
  process.exitCode = 1;
});
