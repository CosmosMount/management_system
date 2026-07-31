import "dotenv/config";
import { logger, withScriptLogging } from "../lib/logger";
import { setupPlaywrightDatabaseOwnership } from "./playwright-db-cleanup";
import { logPlaywrightErrorCauses } from "./playwright-error-reporting";
import {
  assertPlaywrightDatabaseConfirmations,
  assertPlaywrightRecreateOnlyEnvironment,
  resolvePlaywrightDatabaseOwnership,
} from "./playwright-db-safety";

async function main(): Promise<void> {
  // Clone/source settings are rejected before any PostgreSQL connection is opened.
  assertPlaywrightRecreateOnlyEnvironment(process.env);
  const ownership = resolvePlaywrightDatabaseOwnership(process.env);
  assertPlaywrightDatabaseConfirmations(ownership, process.env);

  logger.info("playwright.db.setup.start", {
    module: "playwright",
    action: "setupPlaywrightDb",
    setupMode: "recreate",
    targetDatabaseName: ownership.target.databaseName,
    shadowDatabaseName: ownership.shadow.databaseName,
    notificationDeliveryDisabled:
      process.env.NOTIFICATION_DELIVERY_DISABLED === "true",
  });
  await setupPlaywrightDatabaseOwnership(ownership, process.env);
}

withScriptLogging("setup-playwright-db", main).catch((error) => {
  logger.error("playwright.db.setup.failed", {
    module: "playwright",
    action: "setupPlaywrightDb",
    error,
  });
  logPlaywrightErrorCauses("playwright.db.setup.failure_cause", error, {
    module: "playwright",
    action: "setupPlaywrightDb",
  });
  process.exitCode = 1;
});
