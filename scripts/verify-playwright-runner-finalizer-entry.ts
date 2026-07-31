import { finalizePlaywrightRunnerResult } from "./playwright-runner-finalizer";
import {
  playwrightSignalExitCode,
  type PlaywrightRunnerResult,
} from "./playwright-runner";

const allowedSignals = new Set<NodeJS.Signals>([
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
]);
const allowedModes = new Set(["normal", "ignore", "throw"]);

function createSyntheticResult(signal: NodeJS.Signals): PlaywrightRunnerResult {
  const token = "000000000000000000000000";
  const endpoint = (databaseName: string) => ({
    databaseName,
    hostname: "127.0.0.1",
    port: "5432",
    protocol: "postgresql:",
    url: `postgresql://127.0.0.1/${databaseName}`,
    username: "finalizer_test",
  });
  const nestedCleanupError = new AggregateError(
    [
      new Error(
        "shadow drop failed for postgresql://runner:do-not-log@127.0.0.1/shadow_test",
      ),
      new Error("target drop failed password=do-not-log secret=do-not-log"),
    ],
    "nested exact cleanup failure",
  );
  return {
    cleanupSucceeded: false,
    error: new AggregateError(
      [
        new Error(`Playwright run was interrupted by ${signal}`),
        nestedCleanupError,
      ],
      "entry finalizer verification failure",
    ),
    exitCode: playwrightSignalExitCode(signal),
    ownership: {
      shadow: endpoint(`pw_${token}_shadow_test`),
      target: endpoint(`pw_${token}_target_test`),
      token,
    },
    signal,
  };
}

function main(): void {
  const signal = process.argv[2] as NodeJS.Signals | undefined;
  const mode = process.argv[3] ?? "normal";
  if (!signal || !allowedSignals.has(signal) || !allowedModes.has(mode)) {
    throw new Error(
      "Usage: verify-playwright-runner-finalizer-entry.ts <SIGHUP|SIGINT|SIGTERM> <normal|ignore|throw>",
    );
  }
  if (mode === "ignore") {
    process.on(signal, () => undefined);
  }
  finalizePlaywrightRunnerResult(
    createSyntheticResult(signal),
    mode === "throw"
      ? {
          retriggerSignal: () => {
            throw new Error("injected process.kill failure");
          },
        }
      : undefined,
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
