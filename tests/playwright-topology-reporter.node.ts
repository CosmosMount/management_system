import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FullConfig, Suite } from "@playwright/test/reporter";
import {
  PLAYWRIGHT_TOPOLOGY_SELECTION_MODE_ENV,
  playwrightTopologySelectionMode,
} from "../scripts/playwright-test-topology";
import PlaywrightTopologyReporter from "../scripts/playwright-topology-reporter";
import {
  NODE_DB_SPEC,
  UI_SPEC,
} from "./helpers/playwright-topology-spec-sources";

test("Playwright reporter 通过真实 CLI 区分全集与局部收集并把失败状态传给进程", async () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "playwright-topology-reporter-"),
  );
  const testRoot = path.join(temporaryRoot, "tests");
  mkdirSync(testRoot);
  writeFileSync(path.join(testRoot, "ui.spec.ts"), UI_SPEC, "utf8");
  writeFileSync(path.join(testRoot, "node-db.spec.ts"), NODE_DB_SPEC, "utf8");

  try {
    const filteredReporter = new PlaywrightTopologyReporter({
      repositoryRoot: temporaryRoot,
      selectionMode: "full",
    });
    filteredReporter.onBegin(
      reporterConfig("desktop"),
      reporterSuite("desktop", path.join(testRoot, "ui.spec.ts")),
    );
    assert.equal(await filteredReporter.onEnd(), undefined);

    const missingFullReporter = new PlaywrightTopologyReporter({
      repositoryRoot: temporaryRoot,
      selectionMode: "full",
    });
    missingFullReporter.onBegin(reporterConfig("desktop"), reporterSuite());
    assert.deepEqual(await missingFullReporter.onEnd(), { status: "failed" });

    const missingPartialReporter = new PlaywrightTopologyReporter({
      repositoryRoot: temporaryRoot,
      selectionMode: "partial",
    });
    missingPartialReporter.onBegin(reporterConfig("desktop"), reporterSuite());
    assert.equal(await missingPartialReporter.onEnd(), undefined);

    const invalidReporter = new PlaywrightTopologyReporter({
      repositoryRoot: temporaryRoot,
      selectionMode: "partial",
    });
    invalidReporter.onBegin(
      reporterConfig("node-db"),
      reporterSuite("node-db", path.join(testRoot, "ui.spec.ts")),
    );
    assert.deepEqual(await invalidReporter.onEnd(), { status: "failed" });

    installSyntheticPlaywrightConfig(temporaryRoot);
    const successfulInvocations = [
      [],
      ["--list"],
      ["--project=desktop"],
      ["--project", "desktop"],
      ["--project=Desktop"],
      ["--project=d*"],
      ["--project=*"],
      ["--list", "--project=desktop"],
      ["--list", "--project", "desktop"],
      ["--list", "--project", "desktop", "node-db"],
      ["ui.spec.ts", "--list"],
      ["--list", "--grep=synthetic-ui"],
      ["--list", "--grep", "synthetic-ui"],
    ];
    for (const args of successfulInvocations) {
      const result = runSyntheticPlaywright(temporaryRoot, args, "valid");
      assert.equal(
        result.status,
        0,
        `synthetic Playwright should accept ${JSON.stringify(args)}:\n${result.output}`,
      );
    }

    const benignFullArguments = [
      "--list",
      "--timeout=30000",
      "--headed",
      "--retries=1",
      "--repeat-each=1",
      "--max-failures=1",
      "--global-timeout=60000",
      "--trace=off",
      "--output=artifacts",
      "--quiet",
      "--forbid-only",
      "--fail-on-flaky-tests",
      "--pass-with-no-tests",
    ];
    const benignFullResult = runSyntheticPlaywright(
      temporaryRoot,
      benignFullArguments,
      "valid",
    );
    assert.equal(benignFullResult.status, 0, benignFullResult.output);
    const missingWithBenignArguments = runSyntheticPlaywright(
      temporaryRoot,
      benignFullArguments,
      "missing",
    );
    assert.notEqual(missingWithBenignArguments.status, 0);
    assert.match(
      missingWithBenignArguments.output,
      /Playwright topology validation failed/,
    );

    for (const scenario of ["missing", "wrong-project"] as const) {
      const result = runSyntheticPlaywright(
        temporaryRoot,
        ["--list"],
        scenario,
      );
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /Playwright topology validation failed/);
    }

    const executionMarker = path.join(temporaryRoot, "wrong-project.executed");
    const blockedExecution = runSyntheticPlaywright(
      temporaryRoot,
      [],
      "wrong-project",
      executionMarker,
    );
    assert.equal(blockedExecution.status, 1, blockedExecution.output);
    assert.equal(existsSync(executionMarker), false);

    const missingSelectedProject = runSyntheticPlaywright(
      temporaryRoot,
      ["--list", "--project=node-db"],
      "missing",
    );
    assert.equal(
      missingSelectedProject.status,
      1,
      missingSelectedProject.output,
    );
    assert.match(
      missingSelectedProject.output,
      /Playwright topology validation failed/,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

function reporterConfig(...projectNames: string[]): FullConfig {
  return {
    projects: projectNames.map((name) => ({ name })),
  } as unknown as FullConfig;
}

function reporterSuite(projectName?: string, file?: string): Suite {
  const project = projectName ? { name: projectName } : undefined;
  return {
    allTests: () =>
      project && file
        ? [
            {
              location: { column: 1, file, line: 1 },
              parent: { project: () => project },
            },
          ]
        : [],
    suites: project ? [{ project: () => project, type: "project" }] : [],
  } as unknown as Suite;
}

function installSyntheticPlaywrightConfig(temporaryRoot: string): void {
  symlinkSync(
    path.join(process.cwd(), "node_modules"),
    path.join(temporaryRoot, "node_modules"),
    "dir",
  );
  const reporterPath = path.resolve(
    process.cwd(),
    "scripts/playwright-topology-reporter.ts",
  );
  writeFileSync(
    path.join(temporaryRoot, "playwright.config.ts"),
    `import { defineConfig } from "@playwright/test";
const scenario = process.env.SYNTHETIC_TOPOLOGY_SCENARIO;
const nodeDbMatch = scenario === "missing" ? ["never-collected.spec.ts"] : ["node-db.spec.ts"];
const desktopMatch = scenario === "wrong-project" ? ["node-db.spec.ts"] : ["ui.spec.ts"];
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  reporter: [[${JSON.stringify(reporterPath)}, {
    repositoryRoot: process.cwd(),
    selectionMode: process.env.${PLAYWRIGHT_TOPOLOGY_SELECTION_MODE_ENV},
  }]],
  projects: [
    { name: "node-db", testMatch: nodeDbMatch },
    { name: "desktop", testMatch: desktopMatch },
  ],
});
`,
    "utf8",
  );
}

function runSyntheticPlaywright(
  temporaryRoot: string,
  args: string[],
  scenario: "missing" | "valid" | "wrong-project",
  executionMarker?: string,
): { output: string; status: number | null } {
  const playwrightCli = path.join(
    process.cwd(),
    "node_modules",
    "@playwright",
    "test",
    "cli.js",
  );
  const result = spawnSync(
    process.execPath,
    [playwrightCli, "test", "--config=playwright.config.ts", ...args],
    {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        [PLAYWRIGHT_TOPOLOGY_SELECTION_MODE_ENV]:
          playwrightTopologySelectionMode(args),
        SYNTHETIC_TOPOLOGY_SCENARIO: scenario,
        SYNTHETIC_TOPOLOGY_EXECUTION_MARKER: executionMarker,
      },
    },
  );
  assert.equal(result.error, undefined);
  return {
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  };
}
