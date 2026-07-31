import "dotenv/config";
import { logger } from "../lib/logger";
import { finalizePlaywrightRunnerResult } from "./playwright-runner-finalizer";
import {
  defaultPlaywrightRunnerDependencies,
  runOfficialPlaywright,
} from "./playwright-runner";

async function main(): Promise<void> {
  const result = await runOfficialPlaywright(
    process.env,
    process.argv.slice(2),
    defaultPlaywrightRunnerDependencies(),
  );
  finalizePlaywrightRunnerResult(result);
}

main().catch((error) => {
  logger.error("playwright.run.failed", {
    module: "playwright",
    action: "runPlaywright",
    error,
  });
  process.exitCode = 1;
});
