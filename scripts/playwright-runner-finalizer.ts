import { logger } from "../lib/logger";
import { logPlaywrightErrorCauses } from "./playwright-error-reporting";
import type { PlaywrightRunnerResult } from "./playwright-runner";

type PlaywrightRunnerFinalizerDependencies = {
  retriggerSignal(signal: NodeJS.Signals): void;
};

const defaultFinalizerDependencies: PlaywrightRunnerFinalizerDependencies = {
  retriggerSignal: (signal) => process.kill(process.pid, signal),
};

export function logPlaywrightRunnerResult(
  result: PlaywrightRunnerResult,
): void {
  logger.info("playwright.run.exit", {
    module: "playwright",
    action: "runPlaywright",
    cleanupSucceeded: result.cleanupSucceeded,
    exitCode: result.exitCode,
    signal: result.signal,
    targetDatabaseName: result.ownership.target.databaseName,
    shadowDatabaseName: result.ownership.shadow.databaseName,
    result: result.exitCode === 0 ? "success" : "failure",
  });
  if (!result.error) return;
  logger.error("playwright.run.failed", {
    module: "playwright",
    action: "runPlaywright",
    error: result.error,
  });
  logPlaywrightErrorCauses("playwright.run.failure_cause", result.error, {
    module: "playwright",
    action: "runPlaywright",
  });
}

export function finalizePlaywrightRunnerResult(
  result: PlaywrightRunnerResult,
  dependencies: PlaywrightRunnerFinalizerDependencies =
    defaultFinalizerDependencies,
): void {
  logPlaywrightRunnerResult(result);

  // Establish canonical shell semantics even if signal retriggering throws or
  // a pre-existing listener prevents the default signal action.
  process.exitCode = result.exitCode;
  if (!result.signal) return;
  try {
    dependencies.retriggerSignal(result.signal);
  } catch (error) {
    logger.error("playwright.run.signal_retrigger_failed", {
      module: "playwright",
      action: "runPlaywright",
      exitCode: result.exitCode,
      signal: result.signal,
      error,
    });
  }
}
