import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../lib/logger";
import { controlledNodeTestEnvironment } from "./node-test-runner-safety";
import { runNodeTestEntry } from "./run-node-tests";

const repositoryRoot = process.cwd();
const requireFromVerifier = createRequire(import.meta.url);
const tsxCliPath = requireFromVerifier.resolve("tsx/cli");
const tsxLoaderUrl = pathToFileURL(requireFromVerifier.resolve("tsx")).href;
const dotenvConfigUrl = pathToFileURL(
  requireFromVerifier.resolve("dotenv/config"),
).href;
const nodeTestRunnerPath = path.join(
  repositoryRoot,
  "scripts",
  "run-node-tests.ts",
);
const softBypassUrl =
  "postgresql://node_runner:node_runner@127.0.0.1:1/soft_bypass_test";
const databaseEnvironmentNames = [
  "DATABASE_URL",
  "PLAYWRIGHT_DATABASE_URL",
  "SHADOW_DATABASE_URL",
  "PLAYWRIGHT_SHADOW_DATABASE_URL",
  "PLAYWRIGHT_SOURCE_DATABASE_URL",
] as const;
const removedEnvironmentNames = [
  "PLAYWRIGHT_CONFIRM_HOSTILE",
  "PLAYWRIGHT_DB_OWNERSHIP_HOSTILE",
  "PLAYWRIGHT_DB_SETUP_HOSTILE",
  "PLAYWRIGHT_BASE_URL",
  "PLAYWRIGHT_SERVER_HOSTILE",
  "PLAYWRIGHT_REUSE_HOSTILE",
  "PLAYWRIGHT_SKIP_HOSTILE",
  "SMTP_HOST",
  "PLAYWRIGHT_FEISHU_EGRESS_PROBE_OUTPUT",
  "PLAYWRIGHT_FEISHU_EGRESS_RUN_ID",
  "PLAYWRIGHT_FEISHU_EGRESS_ORIGINAL_NODE_OPTIONS",
  "DOTENV_CONFIG_OVERRIDE",
] as const;

const overriddenEnvironmentNames = [
  "CHECKPOINT_DISABLE",
  "CONFIRM_SEND_FEISHU",
  "EMAIL_DELIVERY_ALLOWED_ADDRESSES",
  "NODE_OPTIONS",
  "NOTIFICATION_DELIVERY_DISABLED",
  "PLAYWRIGHT_FEISHU_EGRESS_DISABLED",
  "PLAYWRIGHT_FEISHU_EGRESS_GUARD_PATH",
] as const;

function mixedCaseEnvironmentName(name: string): string {
  return name
    .toLowerCase()
    .replace(/(^|_)([a-z])/g, (_match, separator: string, letter: string) =>
      `${separator}${letter.toUpperCase()}`,
    );
}

const hostileEnvironmentNames = [
  ...databaseEnvironmentNames,
  ...removedEnvironmentNames,
  ...overriddenEnvironmentNames,
] as const;
const mixedCaseHostileEnv = Object.fromEntries(
  hostileEnvironmentNames.map((name) => [
    mixedCaseEnvironmentName(name),
    "hostile",
  ]),
);
const controlledEnvironment = controlledNodeTestEnvironment(
  {
    ...process.env,
    ...mixedCaseHostileEnv,
    NODE_ENV: "test",
  },
  repositoryRoot,
);

for (const name of databaseEnvironmentNames) {
  assert.equal(controlledEnvironment[name], "", name);
}
for (const name of removedEnvironmentNames) {
  assert.equal(controlledEnvironment[name], undefined, name);
}
for (const name of hostileEnvironmentNames) {
  const mixedCaseName = mixedCaseEnvironmentName(name);
  assert.equal(controlledEnvironment[mixedCaseName], undefined, mixedCaseName);
}
assert.equal(controlledEnvironment.CHECKPOINT_DISABLE, "1");
assert.equal(controlledEnvironment.CONFIRM_SEND_FEISHU, "");
assert.equal(controlledEnvironment.NOTIFICATION_DELIVERY_DISABLED, "true");
assert.equal(controlledEnvironment.EMAIL_DELIVERY_ALLOWED_ADDRESSES, "");
assert.doesNotMatch(controlledEnvironment.NODE_OPTIONS ?? "", /hostile/);

function runInlineTypeScript(
  source: string,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    ["--import", tsxLoaderUrl, "--eval", source],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env,
      timeout: 5_000,
    },
  );
}

const deliveryGuardUrl = pathToFileURL(
  path.join(repositoryRoot, "lib", "feishu-delivery-guard.ts"),
).href;
const softGuardVerifier = String.raw`
  const assert = require('node:assert/strict');
  const http = require('node:http');
  const https = require('node:https');
  const expected = 'PLAYWRIGHT_FEISHU_EGRESS_BLOCKED';
  import(${JSON.stringify(deliveryGuardUrl)})
    .then(async ({ isNotificationDeliveryDisabled }) => {
      assert.equal(
        isNotificationDeliveryDisabled({ ignoreDeliveryDisabled: true }),
        false,
      );
      const error = await fetch('https://open.feishu.cn/open-apis/test').catch(failure => failure);
      assert.equal(error.code, expected);
      for (const request of [
        () => http.get('http://open.feishu.cn/open-apis/test'),
        () => https.request('https://open.feishu.cn/open-apis/test'),
      ]) assert.throws(request, failure => failure?.code === expected);
    })
    .catch(error => { console.error(error); process.exitCode = 1; });
`;
const softGuardResult = runInlineTypeScript(softGuardVerifier, {
  ...controlledEnvironment,
  DATABASE_URL:
    "postgresql://node_runner:node_runner@127.0.0.1:1/node_runner_forbidden",
  PLAYWRIGHT_DATABASE_URL: softBypassUrl,
});
const softGuardError = String(softGuardResult.stderr ?? softGuardResult.error ?? "");
assert.equal(softGuardResult.signal, null, softGuardError);
assert.equal(softGuardResult.status, 0, softGuardError);

const nodeTestRunnerSafetyUrl = pathToFileURL(
  path.join(repositoryRoot, "scripts", "node-test-runner-safety.ts"),
).href;
const defaultSignalFallbackResult = runInlineTypeScript(
  String.raw`
    const assert = require('node:assert/strict');
    import(${JSON.stringify(nodeTestRunnerSafetyUrl)})
      .then(({ finalizeNodeTestSignal }) => {
        let retriggers = 0;
        process.kill = (pid, signal) => {
          assert.equal(pid, process.pid);
          assert.equal(signal, 'SIGTERM');
          retriggers += 1;
          return true;
        };
        finalizeNodeTestSignal('SIGTERM');
        assert.equal(retriggers, 1);
        assert.equal(process.exitCode, 143);
      })
      .catch(error => { console.error(error); process.exitCode = 1; });
  `,
  controlledEnvironment,
);
const defaultSignalFallbackError = String(
  defaultSignalFallbackResult.stderr ??
    defaultSignalFallbackResult.error ??
    "",
);
assert.equal(
  defaultSignalFallbackResult.signal,
  null,
  defaultSignalFallbackError,
);
assert.equal(
  defaultSignalFallbackResult.status,
  143,
  defaultSignalFallbackError,
);

function writeTest(workspace: string, name: string, source: string): void {
  const testDirectory = path.join(workspace, "tests");
  mkdirSync(testDirectory, { recursive: true });
  writeFileSync(path.join(testDirectory, name), source, "utf8");
}

function prepareCliWorkspace(workspace: string): void {
  const scriptsDirectory = path.join(workspace, "scripts");
  mkdirSync(scriptsDirectory, { recursive: true });
  copyFileSync(
    path.join(repositoryRoot, "scripts", "playwright-feishu-egress-guard.mjs"),
    path.join(scriptsDirectory, "playwright-feishu-egress-guard.mjs"),
  );
}

const mixedCaseCliHostileEnv = Object.fromEntries(
  hostileEnvironmentNames
    .filter((name) => name !== "NODE_OPTIONS")
    .map((name) => [mixedCaseEnvironmentName(name), "hostile"]),
);
const nodeTestSubprocessEnvironment = {
  ...process.env,
  ...mixedCaseCliHostileEnv,
  TSX_TSCONFIG_PATH: path.join(repositoryRoot, "tsconfig.json"),
};

function runNodeTestProcess(
  workspace: string,
  args: string[],
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, args, {
    cwd: workspace,
    encoding: "utf8",
    env: nodeTestSubprocessEnvironment,
    timeout: 10_000,
  });
}

function runNodeTestCli(workspace: string): ReturnType<typeof spawnSync> {
  return runNodeTestProcess(workspace, [tsxCliPath, nodeTestRunnerPath]);
}

function spawnFailure(result: ReturnType<typeof spawnSync>): string {
  return [result.stderr, result.stdout, result.error]
    .filter(Boolean)
    .map(String)
    .join("\n");
}

function runEntry(options: Parameters<typeof runNodeTestEntry>[0]): number {
  process.exitCode = 0;
  runNodeTestEntry(options);
  return process.exitCode ?? 0;
}

const temporaryRoot = mkdtempSync(
  path.join(os.tmpdir(), "node-test-runner-safety-"),
);
try {
  const passingWorkspace = path.join(temporaryRoot, "passing workspace");
  mkdirSync(passingWorkspace, { recursive: true });
  prepareCliWorkspace(passingWorkspace);
  writeFileSync(
    path.join(passingWorkspace, ".env"),
    [
      "DATABASE_URL=postgresql://repo:repo@127.0.0.1:5432/repository_database",
      `PLAYWRIGHT_DATABASE_URL=${softBypassUrl}`,
      "SHADOW_DATABASE_URL=postgresql://repo:repo@127.0.0.1:5432/repository_shadow",
    ].join("\n"),
    "utf8",
  );
  const syntheticTestNames = [
    "z-last path.node.ts",
    "a-first path.node.ts",
    "m-middle path.node.ts",
  ] as const;
  const markerPaths = syntheticTestNames.map((name) =>
    path.join(passingWorkspace, `${name}.executed`),
  );
  for (const [index, name] of syntheticTestNames.entries()) {
    writeTest(
      passingWorkspace,
      name,
      `
        import ${JSON.stringify(dotenvConfigUrl)};
        import assert from "node:assert/strict";
        import { writeFileSync } from "node:fs";
        import test from "node:test";

        test(${JSON.stringify(name)}, () => {
          for (const environmentName of ${JSON.stringify(databaseEnvironmentNames)}) {
            assert.equal(process.env[environmentName], "", environmentName);
          }
          for (const environmentName of ${JSON.stringify(Object.keys(mixedCaseCliHostileEnv))}) {
            assert.equal(Object.keys(process.env).includes(environmentName), false, environmentName);
          }
          assert.equal(process.env.NOTIFICATION_DELIVERY_DISABLED, "true");
          assert.equal(process.env.EMAIL_DELIVERY_ALLOWED_ADDRESSES, "");
          assert.doesNotMatch(process.env.NODE_OPTIONS ?? "", /hostile/);
          assert.throws(() => new URL(process.env.DATABASE_URL ?? ""));
          writeFileSync(${JSON.stringify(markerPaths[index])}, "executed", "utf8");
        });
      `,
    );
  }

  let discoveredCommand = "";
  let discoveredArgs: string[] = [];
  assert.equal(
    runEntry({
      guardRoot: repositoryRoot,
      repositoryRoot: passingWorkspace,
      spawnNodeTests: (command, args, options) => {
        discoveredCommand = command;
        discoveredArgs = args;
        assert.equal(options?.cwd, passingWorkspace);
        return { signal: null, status: 0 };
      },
    }),
    0,
  );
  assert.equal(discoveredCommand, process.execPath);
  assert.deepEqual(discoveredArgs, [
    "--import",
    tsxLoaderUrl,
    "--test",
    ...[...syntheticTestNames]
      .sort()
      .map((name) => path.join(passingWorkspace, "tests", name)),
  ]);

  const passingCliResult = runNodeTestCli(passingWorkspace);
  assert.equal(passingCliResult.signal, null, spawnFailure(passingCliResult));
  assert.equal(passingCliResult.status, 0, spawnFailure(passingCliResult));
  for (const markerPath of markerPaths) {
    assert.equal(existsSync(markerPath), true, markerPath);
  }

  const emptyWorkspace = path.join(temporaryRoot, "empty workspace");
  mkdirSync(path.join(emptyWorkspace, "tests"), { recursive: true });
  const emptyErrors: unknown[] = [];
  assert.equal(
    runEntry({
      guardRoot: repositoryRoot,
      logError: (error) => emptyErrors.push(error),
      repositoryRoot: emptyWorkspace,
    }),
    1,
  );
  assert.match(String(emptyErrors[0]), /No tests\/\*\.node\.ts files/);

  assert.equal(
    runEntry({
      guardRoot: repositoryRoot,
      logError: () => assert.fail("ordinary child failures must use status"),
      repositoryRoot: passingWorkspace,
      spawnNodeTests: () => ({ signal: null, status: 23 }),
    }),
    23,
  );

  for (const [signal, expectedExitCode] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    const retriggered: NodeJS.Signals[] = [];
    assert.equal(
      runEntry({
        guardRoot: repositoryRoot,
        repositoryRoot: passingWorkspace,
        retriggerSignal: (received) => retriggered.push(received),
        spawnNodeTests: () => ({ signal, status: null }),
      }),
      expectedExitCode,
    );
    assert.deepEqual(retriggered, [signal]);
  }

  const retriggerErrors: unknown[] = [];
  assert.equal(
    runEntry({
      guardRoot: repositoryRoot,
      logError: (error) => retriggerErrors.push(error),
      repositoryRoot: passingWorkspace,
      retriggerSignal: () => {
        throw new Error("synthetic retrigger failure");
      },
      spawnNodeTests: () => ({ signal: "SIGTERM", status: null }),
    }),
    143,
  );
  assert.match(String(retriggerErrors[0]), /synthetic retrigger failure/);

  const unknownRetriggers: NodeJS.Signals[] = [];
  assert.equal(
    runEntry({
      guardRoot: repositoryRoot,
      repositoryRoot: passingWorkspace,
      retriggerSignal: (signal) => unknownRetriggers.push(signal),
      spawnNodeTests: () => ({ signal: "SIGKILL", status: null }),
    }),
    1,
  );
  assert.deepEqual(unknownRetriggers, ["SIGKILL"]);

  // Windows does not expose POSIX signal termination through spawnSync
  // consistently. Portable mapping/default-fallback checks still run above;
  // POSIX additionally verifies the real runner's default signal retrigger.
  if (process.platform !== "win32") {
    const signalWorkspace = path.join(temporaryRoot, "signal workspace");
    prepareCliWorkspace(signalWorkspace);
    writeTest(
      signalWorkspace,
      "signals test runner.node.ts",
      `
        process.kill(process.ppid, "SIGHUP");
        process.exit(0);
      `,
    );

    const runnerEntryArgs = ["--import", tsxLoaderUrl, nodeTestRunnerPath];
    const retriggerResult = runNodeTestProcess(
      signalWorkspace,
      runnerEntryArgs,
    );
    assert.equal(retriggerResult.status, null, spawnFailure(retriggerResult));
    assert.equal(retriggerResult.signal, "SIGHUP", spawnFailure(retriggerResult));

    const signalHandlerPath = path.join(temporaryRoot, "ignore-sighup.mjs");
    writeFileSync(
      signalHandlerPath,
      'process.once("SIGHUP", () => {});\n',
      "utf8",
    );
    const fallbackResult = runNodeTestProcess(signalWorkspace, [
      "--import",
      pathToFileURL(signalHandlerPath).href,
      ...runnerEntryArgs,
    ]);
    assert.equal(fallbackResult.signal, null, spawnFailure(fallbackResult));
    assert.equal(fallbackResult.status, 129, spawnFailure(fallbackResult));
  }
} finally {
  process.exitCode = 0;
  rmSync(temporaryRoot, { force: true, recursive: true });
}

logger.info("node_tests.runner_safety.verified", {
  module: "test",
  action: "verifyNodeTestRunnerSafety",
  result: "success",
});
