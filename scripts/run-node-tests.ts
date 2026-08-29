import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "../lib/logger";
import {
  controlledNodeTestEnvironment,
  finalizeNodeTestSignal,
} from "./node-test-runner-safety";

const NODE_TEST_SUFFIX = ".node.ts";
const tsxLoaderUrl = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;

type NodeTestSpawnResult = {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
};

type NodeTestRunnerOptions = {
  guardRoot?: string;
  logError?(error: unknown): void;
  repositoryRoot?: string;
  retriggerSignal?(signal: NodeJS.Signals): void;
  spawnNodeTests?(
    command: string,
    args: string[],
    options: Parameters<typeof spawnSync>[2],
  ): NodeTestSpawnResult;
};

function runNodeTests(options: NodeTestRunnerOptions): void {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const guardRoot = options.guardRoot ?? repositoryRoot;
  const testDirectory = path.join(repositoryRoot, "tests");
  const testFiles = readdirSync(testDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(NODE_TEST_SUFFIX))
    .map((entry) => path.join(testDirectory, entry.name))
    .sort();

  if (testFiles.length === 0) {
    throw new Error(`No tests/*${NODE_TEST_SUFFIX} files were found`);
  }

  const result = (options.spawnNodeTests ?? spawnSync)(
    process.execPath,
    ["--import", tsxLoaderUrl, "--test", ...testFiles],
    {
      cwd: repositoryRoot,
      env: controlledNodeTestEnvironment(process.env, guardRoot),
      stdio: "inherit",
    },
  );

  if (result.error) throw result.error;
  if (result.signal) {
    finalizeNodeTestSignal(result.signal, options.retriggerSignal);
    return;
  }
  process.exitCode = result.status ?? 1;
}

export function runNodeTestEntry(options: NodeTestRunnerOptions = {}): void {
  try {
    runNodeTests(options);
  } catch (error) {
    (options.logError ?? ((failure) => {
      logger.error("node_tests.run.failed", {
        module: "test",
        action: "runNodeTests",
        error: failure,
      });
    }))(error);
    process.exitCode ||= 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runNodeTestEntry();
}
