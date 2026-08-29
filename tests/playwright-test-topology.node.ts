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
  discoverPlaywrightTestTopology,
  PLAYWRIGHT_TOPOLOGY_SELECTION_MODE_ENV,
  playwrightProjectSelection,
  playwrightTopologySelectionMode,
  selectedPlaywrightProjectNames,
} from "../scripts/playwright-test-topology";
import PlaywrightTopologyReporter from "../scripts/playwright-topology-reporter";

test("当前 Playwright spec 唯一归入 29 个 UI 或 45 个 node-db", () => {
  const topology = discoverPlaywrightTestTopology();
  assert.equal(topology.ui.length, 29);
  assert.equal(topology.nodeDb.length, 45);
  assert.equal(new Set([...topology.ui, ...topology.nodeDb]).size, 74);
  assert.ok(
    [...topology.ui, ...topology.nodeDb].every((file) =>
      file.endsWith(".spec.ts"),
    ),
  );
});

test("Playwright 分类和 selection mode 对声明、AST binding 与 CLI 过滤 fail closed", () => {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "playwright-topology-"),
  );
  const testRoot = path.join(temporaryRoot, "tests");
  mkdirSync(testRoot);
  const writeSpec = (name: string, source: string) =>
    writeFileSync(path.join(testRoot, name), source, "utf8");
  const removeSpec = (name: string) => rmSync(path.join(testRoot, name));

  try {
    writeSpec("ui.spec.ts", UI_SPEC);
    writeSpec("node-db.spec.ts", NODE_DB_SPEC);
    assert.deepEqual(discoverPlaywrightTestTopology(temporaryRoot), {
      nodeDb: ["node-db.spec.ts"],
      ui: ["ui.spec.ts"],
    });

    writeSpec("missing.spec.ts", "test('missing', () => undefined);\n");
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /must start with exactly one/,
    );
    removeSpec("missing.spec.ts");

    writeSpec(
      "duplicate.spec.ts",
      `${NODE_DB_SPEC}// @playwright-project ui\n`,
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /must start with exactly one/,
    );
    removeSpec("duplicate.spec.ts");

    writeSpec(
      "no-official-import.spec.ts",
      `// @playwright-project node-db\ntest("missing import", async () => undefined);\n`,
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /must import test directly from @playwright\/test/,
    );
    removeSpec("no-official-import.spec.ts");

    writeSpec(
      "wrong-node-db.spec.ts",
      UI_SPEC.replace("@playwright-project ui", "@playwright-project node-db"),
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /declares node-db but uses a browser fixture/,
    );
    removeSpec("wrong-node-db.spec.ts");

    writeSpec(
      "wrong-ui.spec.ts",
      NODE_DB_SPEC.replace("@playwright-project node-db", "@playwright-project ui"),
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /declares ui but uses no browser fixture/,
    );
    removeSpec("wrong-ui.spec.ts");

    writeSpec("wrong-project-skip.spec.ts", NODE_DB_PROJECT_SKIP_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /declares node-db but skips a desktop or mobile project/,
    );
    removeSpec("wrong-project-skip.spec.ts");

    writeSpec("alias-ui.spec.ts", UI_ALIAS_SPEC);
    assert.ok(discoverPlaywrightTestTopology(temporaryRoot).ui.includes("alias-ui.spec.ts"));
    removeSpec("alias-ui.spec.ts");

    writeSpec(
      "alias-node-db.spec.ts",
      UI_ALIAS_SPEC.replace("@playwright-project ui", "@playwright-project node-db"),
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /declares node-db but uses a browser fixture/,
    );
    removeSpec("alias-node-db.spec.ts");

    writeSpec("escaped-fixture-ui.spec.ts", ESCAPED_FIXTURE_UI_SPEC);
    assert.ok(
      discoverPlaywrightTestTopology(temporaryRoot).ui.includes(
        "escaped-fixture-ui.spec.ts",
      ),
    );
    removeSpec("escaped-fixture-ui.spec.ts");

    writeSpec(
      "escaped-fixture-node-db.spec.ts",
      ESCAPED_FIXTURE_UI_SPEC.replace(
        "@playwright-project ui",
        "@playwright-project node-db",
      ),
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /declares node-db but uses a browser fixture/,
    );
    removeSpec("escaped-fixture-node-db.spec.ts");

    writeSpec("computed-fixture-key.spec.ts", COMPUTED_FIXTURE_KEY_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /uses a non-static fixture key/,
    );
    removeSpec("computed-fixture-key.spec.ts");

    writeSpec("supported-playwright-api.spec.ts", SUPPORTED_PLAYWRIGHT_API_SPEC);
    assert.ok(
      discoverPlaywrightTestTopology(temporaryRoot).nodeDb.includes(
        "supported-playwright-api.spec.ts",
      ),
    );
    removeSpec("supported-playwright-api.spec.ts");

    writeSpec("suite-map-constructor.spec.ts", SUITE_MAP_CONSTRUCTOR_SPEC);
    assert.ok(
      discoverPlaywrightTestTopology(temporaryRoot).nodeDb.includes(
        "suite-map-constructor.spec.ts",
      ),
    );
    removeSpec("suite-map-constructor.spec.ts");

    writeSpec("isolated-global-shadow.spec.ts", ISOLATED_GLOBAL_SHADOW_SPEC);
    assert.ok(
      discoverPlaywrightTestTopology(temporaryRoot).nodeDb.includes(
        "isolated-global-shadow.spec.ts",
      ),
    );
    removeSpec("isolated-global-shadow.spec.ts");

    writeSpec("official-test-shadow.spec.ts", OFFICIAL_TEST_SHADOW_SPEC);
    assert.ok(
      discoverPlaywrightTestTopology(temporaryRoot).nodeDb.includes(
        "official-test-shadow.spec.ts",
      ),
    );
    removeSpec("official-test-shadow.spec.ts");

    for (const annotationMethod of ["skip", "fixme", "fail", "slow"]) {
      const filename = `conditional-${annotationMethod}.spec.ts`;
      writeSpec(filename, conditionalAnnotationSpec(annotationMethod));
      assert.throws(
        () => discoverPlaywrightTestTopology(temporaryRoot),
        /declares node-db but uses a browser fixture/,
      );
      removeSpec(filename);

      const wrappedFilename = `wrapped-conditional-${annotationMethod}.spec.ts`;
      writeSpec(
        wrappedFilename,
        wrappedConditionalAnnotationSpec(annotationMethod),
      );
      assert.throws(
        () => discoverPlaywrightTestTopology(temporaryRoot),
        /declares node-db but uses a browser fixture/,
      );
      removeSpec(wrappedFilename);

      const indirectFilename = `indirect-conditional-${annotationMethod}.spec.ts`;
      writeSpec(
        indirectFilename,
        indirectConditionalAnnotationSpec(annotationMethod),
      );
      assert.throws(
        () => discoverPlaywrightTestTopology(temporaryRoot),
        /non-inline conditional callback/,
      );
      removeSpec(indirectFilename);
    }

    writeSpec("custom-fixture.spec.ts", CUSTOM_FIXTURE_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /imports a custom test fixture/,
    );
    removeSpec("custom-fixture.spec.ts");

    writeSpec("renamed-custom-fixture.spec.ts", RENAMED_CUSTOM_FIXTURE_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /untrusted call while registering tests/,
    );
    removeSpec("renamed-custom-fixture.spec.ts");

    writeSpec("indirect-callback.spec.ts", INDIRECT_CALLBACK_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /non-inline callback/,
    );
    removeSpec("indirect-callback.spec.ts");

    writeSpec("local-alias.spec.ts", LOCAL_ALIAS_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /official test binding outside an approved direct test API call/,
    );
    removeSpec("local-alias.spec.ts");

    writeSpec("computed-alias.spec.ts", COMPUTED_ALIAS_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /official test binding outside an approved direct test API call/,
    );
    removeSpec("computed-alias.spec.ts");

    writeSpec("bound-alias.spec.ts", BOUND_ALIAS_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /unsupported test API test\.bind/,
    );
    removeSpec("bound-alias.spec.ts");

    writeSpec("container-alias.spec.ts", CONTAINER_ALIAS_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /official test binding outside an approved direct test API call/,
    );
    removeSpec("container-alias.spec.ts");

    writeSpec("factory-alias.spec.ts", FACTORY_ALIAS_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /official test binding outside an approved direct test API call/,
    );
    removeSpec("factory-alias.spec.ts");

    for (const [filename, source] of [
      ["parameter-alias.spec.ts", PARAMETER_ALIAS_SPEC],
      ["default-parameter-alias.spec.ts", DEFAULT_PARAMETER_ALIAS_SPEC],
      ["call-return-alias.spec.ts", CALL_RETURN_ALIAS_SPEC],
    ] as const) {
      writeSpec(filename, source);
      assert.throws(
        () => discoverPlaywrightTestTopology(temporaryRoot),
        /official test binding outside an approved direct test API call/,
      );
      removeSpec(filename);
    }

    writeSpec("registration-helper.spec.ts", REGISTRATION_HELPER_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /untrusted call while registering tests/,
    );
    removeSpec("registration-helper.spec.ts");

    writeSpec(
      "describe-registration-helper.spec.ts",
      DESCRIBE_REGISTRATION_HELPER_SPEC,
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /untrusted call while registering tests/,
    );
    removeSpec("describe-registration-helper.spec.ts");

    for (const [filename, source] of [
      ["safe-global-registration-helper.spec.ts", SAFE_GLOBAL_REGISTRATION_HELPER_SPEC],
      ["promise-registration-helper.spec.ts", PROMISE_REGISTRATION_HELPER_SPEC],
      ["constructor-registration-helper.spec.ts", CONSTRUCTOR_REGISTRATION_HELPER_SPEC],
      ["shadowed-function-global.spec.ts", SHADOWED_FUNCTION_GLOBAL_SPEC],
      ["shadowed-alias-global.spec.ts", SHADOWED_ALIAS_GLOBAL_SPEC],
      ["shadowed-constructor-global.spec.ts", SHADOWED_CONSTRUCTOR_GLOBAL_SPEC],
      ["shadowed-node-builtin-function.spec.ts", SHADOWED_NODE_BUILTIN_FUNCTION_SPEC],
      ["shadowed-node-builtin-alias.spec.ts", SHADOWED_NODE_BUILTIN_ALIAS_SPEC],
      ["node-builtin-factory-helper.spec.ts", NODE_BUILTIN_FACTORY_HELPER_SPEC],
      ["wrapped-node-builtin-callback.spec.ts", WRAPPED_NODE_BUILTIN_CALLBACK_SPEC],
      ["conditional-node-builtin-factory.spec.ts", CONDITIONAL_NODE_BUILTIN_FACTORY_SPEC],
      ["conditional-node-builtin-callback.spec.ts", CONDITIONAL_NODE_BUILTIN_CALLBACK_SPEC],
      ["destructured-node-builtin-callback.spec.ts", DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC],
      ["spread-destructured-node-builtin-callback.spec.ts", SPREAD_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC],
      ["computed-destructured-node-builtin-callback.spec.ts", COMPUTED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC],
      ["assigned-destructured-node-builtin-callback.spec.ts", ASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC],
      ["reassigned-destructured-node-builtin-callback.spec.ts", REASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC],
      ["property-alias-node-builtin-callback.spec.ts", PROPERTY_ALIAS_NODE_BUILTIN_CALLBACK_SPEC],
      ["shadowed-process-env-callback.spec.ts", SHADOWED_PROCESS_ENV_CALLBACK_SPEC],
      ["process-env-prototype-callback.spec.ts", PROCESS_ENV_PROTOTYPE_CALLBACK_SPEC],
      ["process-env-conditional-callback.spec.ts", PROCESS_ENV_CONDITIONAL_CALLBACK_SPEC],
    ] as const) {
      writeSpec(filename, source);
      assert.throws(
        () => discoverPlaywrightTestTopology(temporaryRoot),
        /untrusted call while registering tests/,
      );
      removeSpec(filename);
    }

    writeSpec("replaced-process-env-callback.spec.ts", REPLACED_PROCESS_ENV_CALLBACK_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /replaces global process or process\.env while registering tests/,
    );
    removeSpec("replaced-process-env-callback.spec.ts");

    for (const [filename, source] of [
      ["replaced-global-process.spec.ts", REPLACED_GLOBAL_PROCESS_SPEC],
      ["replaced-global-computed-process.spec.ts", REPLACED_GLOBAL_COMPUTED_PROCESS_SPEC],
      ["replaced-global-constant-key-process.spec.ts", REPLACED_GLOBAL_CONSTANT_KEY_PROCESS_SPEC],
    ] as const) {
      writeSpec(filename, source);
      assert.throws(
        () => discoverPlaywrightTestTopology(temporaryRoot),
        /replaces global process or process\.env while registering tests/,
      );
      removeSpec(filename);
    }

    writeSpec(
      "shadowed-boolean-condition.spec.ts",
      SHADOWED_BOOLEAN_CONDITION_SPEC,
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /non-inline conditional callback or non-static condition/,
    );
    removeSpec("shadowed-boolean-condition.spec.ts");

    for (const [filename, source] of [
      ["registration-getter.spec.ts", REGISTRATION_GETTER_SPEC],
      ["nested-registration-getter.spec.ts", NESTED_REGISTRATION_GETTER_SPEC],
      ["inline-registration-getter.spec.ts", INLINE_REGISTRATION_GETTER_SPEC],
      ["imported-registration-getter.spec.ts", IMPORTED_REGISTRATION_GETTER_SPEC],
    ] as const) {
      writeSpec(filename, source);
      assert.throws(
        () => discoverPlaywrightTestTopology(temporaryRoot),
        /reads an untrusted property while registering tests/,
      );
      removeSpec(filename);
    }

    writeSpec(
      "define-property-registration-getter.spec.ts",
      DEFINE_PROPERTY_REGISTRATION_GETTER_SPEC,
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /untrusted call while registering tests/,
    );
    removeSpec("define-property-registration-getter.spec.ts");

    for (const [filename, source, message] of [
      [
        "destructured-registration-getter.spec.ts",
        DESTRUCTURED_REGISTRATION_GETTER_SPEC,
        /destructures an untrusted accessor source/,
      ],
      [
        "spread-registration-getter.spec.ts",
        SPREAD_REGISTRATION_GETTER_SPEC,
        /spreads an untrusted accessor source/,
      ],
      [
        "spread-registration-iterator.spec.ts",
        SPREAD_REGISTRATION_ITERATOR_SPEC,
        /spreads an untrusted iterable/,
      ],
    ] as const) {
      writeSpec(filename, source);
      assert.throws(
        () => discoverPlaywrightTestTopology(temporaryRoot),
        message,
      );
      removeSpec(filename);
    }

    writeSpec(
      "registration-tagged-template.spec.ts",
      REGISTRATION_TAGGED_TEMPLATE_SPEC,
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /untrusted tagged template while registering tests/,
    );
    removeSpec("registration-tagged-template.spec.ts");

    writeSpec("string-raw-tag.spec.ts", STRING_RAW_TAG_SPEC);
    assert.ok(
      discoverPlaywrightTestTopology(temporaryRoot).nodeDb.includes(
        "string-raw-tag.spec.ts",
      ),
    );
    removeSpec("string-raw-tag.spec.ts");

    for (const [filename, source] of [
      ["shadowed-string-raw-tag.spec.ts", SHADOWED_STRING_RAW_TAG_SPEC],
      ["imported-string-raw-tag.spec.ts", IMPORTED_STRING_RAW_TAG_SPEC],
    ] as const) {
      writeSpec(filename, source);
      assert.throws(
        () => discoverPlaywrightTestTopology(temporaryRoot),
        /untrusted tagged template while registering tests/,
      );
      removeSpec(filename);
    }

    writeSpec("namespace-fixture.spec.ts", NAMESPACE_FIXTURE_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /destructures an untrusted accessor source/,
    );
    removeSpec("namespace-fixture.spec.ts");

    writeSpec("inline-extend.spec.ts", INLINE_EXTEND_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /calls test\.extend/,
    );
    removeSpec("inline-extend.spec.ts");

    writeSpec("ordinary-helper.spec.ts", OFFICIAL_TEST_WITH_HELPER_SPEC);
    assert.ok(
      discoverPlaywrightTestTopology(temporaryRoot).ui.includes(
        "ordinary-helper.spec.ts",
      ),
    );

    for (const unsupportedFilename of PLAYWRIGHT_DEFAULT_UNSUPPORTED_FILENAMES) {
      writeSpec(unsupportedFilename, NODE_DB_SPEC);
      assert.throws(
        () => discoverPlaywrightTestTopology(temporaryRoot),
        new RegExp(`${unsupportedFilename.replaceAll(".", "\\.")}.*only supports \\.spec\\.ts`),
      );
      removeSpec(unsupportedFilename);
    }

    const fullSelections = [
      [],
      ["--list"],
      ["--timeout", "30000"],
      ["--timeout=30000"],
      ["--headed"],
      ["--retries", "1"],
      ["--retries=1"],
      ["--repeat-each", "2"],
      ["--repeat-each=2"],
      ["--max-failures", "1"],
      ["--max-failures=1"],
      ["--global-timeout", "60000"],
      ["--global-timeout=60000"],
      ["--trace", "off"],
      ["--trace=off"],
      ["--output", "artifacts"],
      ["--output=artifacts"],
      ["--quiet"],
      ["--forbid-only"],
      ["--fail-on-flaky-tests"],
      ["--pass-with-no-tests"],
      ["--project=desktop"],
      ["--project=Desktop"],
      ["--project=d*"],
      ["--project=*"],
      ["--project", "desktop"],
      ["--project", "desktop", "mobile"],
      ["--list", "--project=desktop", "--project=mobile"],
    ];
    for (const args of fullSelections) {
      assert.equal(playwrightTopologySelectionMode(args), "full");
    }
    const partialSelections = [
      ["ui.spec.ts"],
      ["ui.spec.ts:3"],
      ["--grep", "ui"],
      ["--grep=ui"],
      ["--grep-invert", "slow"],
      ["--grep-invert=slow"],
      ["--shard", "1/2"],
      ["--shard=1/2"],
      ["--last-failed"],
      ["--only-changed"],
      ["--only-changed", "HEAD~1"],
      ["--only-changed=HEAD~1"],
      ["--test-list", "selected.txt"],
      ["--test-list=selected.txt"],
      ["--test-list-invert", "excluded.txt"],
      ["--test-list-invert=excluded.txt"],
    ];
    for (const args of partialSelections) {
      assert.equal(playwrightTopologySelectionMode(args), "partial");
    }
    for (const args of [
      ["--unknown-option"],
      ["--timeout"],
      ["--project"],
      ["--project="],
      ["--grep="],
    ]) {
      assert.throws(
        () => playwrightTopologySelectionMode(args),
        /Unsupported|requires/,
      );
    }

    assert.deepEqual(playwrightProjectSelection([]), null);
    assert.deepEqual(
      playwrightProjectSelection([
        "--list",
        "--project=Desktop",
        "--project",
        "m*",
        "node-db",
      ]),
      ["Desktop", "m*", "node-db"],
    );
    assert.deepEqual(
      selectedPlaywrightProjectNames(
        ["node-db", "desktop", "mobile"],
        ["Desktop"],
      ),
      ["desktop"],
    );
    assert.deepEqual(
      selectedPlaywrightProjectNames(
        ["node-db", "desktop", "mobile"],
        ["d*"],
      ),
      ["desktop"],
    );
    assert.deepEqual(
      selectedPlaywrightProjectNames(
        ["node-db", "desktop", "mobile"],
        ["*"],
      ),
      ["node-db", "desktop", "mobile"],
    );
    assert.throws(
      () =>
        selectedPlaywrightProjectNames(
          ["node-db", "desktop", "mobile"],
          ["missing"],
        ),
      /not found/,
    );
    assert.throws(
      () =>
        selectedPlaywrightProjectNames(
          ["node-db", "desktop", "mobile"],
          ["z*"],
        ),
      /No projects matched/,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

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
      ["--list", "--project", "desktop", "mobile"],
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
      const result = runSyntheticPlaywright(temporaryRoot, ["--list"], scenario);
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
    assert.equal(missingSelectedProject.status, 1, missingSelectedProject.output);
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
  symlinkSync(path.join(process.cwd(), "node_modules"), path.join(temporaryRoot, "node_modules"), "dir");
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
    { name: "mobile", testMatch: ["ui.spec.ts"] },
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

const UI_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
test.skip(true, "synthetic topology fixture");
test("synthetic-ui", async ({ page }) => void page);
`;
const NODE_DB_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
test("synthetic-node-db", async () => {
  const marker = process.env.SYNTHETIC_TOPOLOGY_EXECUTION_MARKER;
  if (marker) writeFileSync(marker, "executed", "utf8");
});
`;
const NODE_DB_PROJECT_SKIP_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
test("node-db", async ({}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "run once");
});
`;
const UI_ALIAS_SPEC = `// @playwright-project ui
import { test as it } from "@playwright/test";
it("ui alias", async ({ page }) => void page);
`;
const ESCAPED_FIXTURE_UI_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
test("escaped fixture", async ({ p\\u0061ge }) => void page);
`;
const COMPUTED_FIXTURE_KEY_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
test("computed fixture", async ({ ["page"]: page }) => void page);
`;
const SUPPORTED_PLAYWRIGHT_API_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
test.describe.fixme("fixme suite", () => {
  test("fixme test", async () => undefined);
});
test.describe.serial.only("serial suite", () => {
  test("serial test", async () => undefined);
});
test.describe.parallel.only("parallel suite", () => {
  test("parallel test", async () => undefined);
});
test("reads TestInfo", async () => {
  const projectName = test.info().project.name;
  const testInfo = test.info();
  await test.info().attach("synthetic", {
    body: "topology",
    contentType: "text/plain",
  });
  void projectName;
  void testInfo.title;
});
test("uses TestType expect paths", async () => {
  test.expect.soft(1).toBe(1);
  await test.expect.poll(() => 1).toBe(1);
  test.expect.configure({ soft: true })(1).toBe(1);
  test.expect.extend({
    toBeOne(received) {
      return { pass: received === 1, message: () => "expected one" };
    },
  })(1).toBeOne();
  void test.expect.getState();
  test.expect(test.expect.any(Number)).toBeTruthy();
  test.expect(test.expect.not.stringContaining("hidden")).toBeTruthy();
});
`;
const SUITE_MAP_CONSTRUCTOR_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
test.describe("suite", () => {
  const originalEnv = new Map<string, string | undefined>();
  test.beforeEach(() => {
    originalEnv.set("NAME", process.env.NAME);
  });
  test("uses map", async () => undefined);
});
`;
const ISOLATED_GLOBAL_SHADOW_SPEC = `// @playwright-project node-db
import { readFileSync } from "node:fs";
import { test } from "@playwright/test";
test.skip(Boolean(false), "static condition");
new Map();
Array.isArray([]);
readFileSync("fixture");
function nested(Array, Boolean, Map, readFileSync) {
  void Array;
  void Boolean;
  void Map;
  void readFileSync;
}
test("official", async () => undefined);
`;
const OFFICIAL_TEST_SHADOW_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
test("official", async () => {
  const echo = (test: string) => test;
  const invoke = (test: () => number) => test();
  function increment(test: number) {
    return test + 1;
  }
  void echo("ok");
  void invoke(() => 1);
  void increment(1);
});
`;
function conditionalAnnotationSpec(annotationMethod: string): string {
  return `// @playwright-project node-db
import { test } from "@playwright/test";
test.${annotationMethod}(({ page }) => Boolean(page), "browser condition");
test("official node test", async () => undefined);
`;
}
function indirectConditionalAnnotationSpec(annotationMethod: string): string {
  return `// @playwright-project node-db
import { test } from "@playwright/test";
const condition = ({ page }) => Boolean(page);
test.${annotationMethod}(condition, "browser condition");
test("official node test", async () => undefined);
`;
}
function wrappedConditionalAnnotationSpec(annotationMethod: string): string {
  return `// @playwright-project node-db
import { test } from "@playwright/test";
test.${annotationMethod}((((({ page }) => Boolean(page))) as ({ page }: { page: unknown }) => boolean), "browser condition");
test("official node test", async () => undefined);
`;
}
const CUSTOM_FIXTURE_SPEC = `// @playwright-project ui
import { test as custom } from "./fixtures";
custom("custom", async ({ page }) => void page);
`;
const RENAMED_CUSTOM_FIXTURE_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
import { custom } from "./fixtures";
custom("custom", async ({ page }) => void page);
test("official", async ({ page }) => void page);
`;
const INDIRECT_CALLBACK_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
const callback = async ({ page }: { page: unknown }) => void page;
test("indirect callback", callback);
`;
const LOCAL_ALIAS_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
const it = test;
it("local alias", async ({ page }) => void page);
`;
const COMPUTED_ALIAS_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
const it = test["only"];
it("computed alias", async ({ page }) => void page);
`;
const BOUND_ALIAS_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
const it = test.bind(undefined);
it("bound alias", async ({ page }) => void page);
`;
const CONTAINER_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
const box = { it: test };
box.it("container alias", async ({ page }) => void page);
`;
const FACTORY_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
const it = (() => test)();
it("factory alias", async ({ page }) => void page);
`;
const PARAMETER_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
function register(it) {
  it("parameter alias", async ({ page }) => void page);
}
register(test);
`;
const DEFAULT_PARAMETER_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
function register(it = test) {
  it("default parameter alias", async ({ page }) => void page);
}
register();
`;
const CALL_RETURN_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
function currentTest() {
  return test;
}
const it = currentTest();
it("call return alias", async ({ page }) => void page);
`;
const REGISTRATION_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
register();
test("official", async () => undefined);
`;
const DESCRIBE_REGISTRATION_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
test.describe("suite", () => {
  register();
});
test("official", async () => undefined);
`;
const SAFE_GLOBAL_REGISTRATION_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
  return 0;
}
Array.from([0], register);
test("official", async () => undefined);
`;
const PROMISE_REGISTRATION_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register(resolve) {
  custom("custom", async ({ page }) => void page);
  resolve();
}
new Promise(register);
test("official", async () => undefined);
`;
const CONSTRUCTOR_REGISTRATION_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
class Register {
  constructor() {
    custom("custom", async ({ page }) => void page);
  }
}
new Register();
test("official", async () => undefined);
`;
const SHADOWED_FUNCTION_GLOBAL_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function Array() {
  custom("custom", async ({ page }) => void page);
}
Array();
test("official", async () => undefined);
`;
const SHADOWED_ALIAS_GLOBAL_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
const Array = register;
Array();
test("official", async () => undefined);
`;
const SHADOWED_CONSTRUCTOR_GLOBAL_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
class Array {
  constructor() {
    custom("custom", async ({ page }) => void page);
  }
}
new Array();
test("official", async () => undefined);
`;
const SHADOWED_NODE_BUILTIN_FUNCTION_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { custom } from "./fixtures";
test.describe("suite", () => {
  function readFileSync() {
    custom("custom", async ({ page }) => void page);
  }
  readFileSync();
});
test("official", async () => undefined);
`;
const SHADOWED_NODE_BUILTIN_ALIAS_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
test.describe("suite", () => {
  const readFileSync = register;
  readFileSync();
});
test("official", async () => undefined);
`;
const NODE_BUILTIN_FACTORY_HELPER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { promisify } from "node:util";
import { custom } from "./fixtures";
function register(callback) {
  custom("custom", async ({ page }) => void page);
  callback(null);
}
promisify(register)();
test("official", async () => undefined);
`;
const WRAPPED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { promisify } from "node:util";
import { custom } from "./fixtures";
promisify((((callback) => {
  custom("custom", async ({ page }) => void page);
  callback(null);
}) as (callback: (error: null) => void) => void))();
test("official", async () => undefined);
`;
const CONDITIONAL_NODE_BUILTIN_FACTORY_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { promisify } from "node:util";
import { custom } from "./fixtures";
function register(callback) {
  custom("custom", async ({ page }) => void page);
  callback(null);
}
promisify(true ? register : register)();
test("official", async () => undefined);
`;
const CONDITIONAL_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
doesNotThrow(true ? register : register);
test("official", async () => undefined);
`;
const DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  register() {
    custom("hidden browser test", async ({ page }) => void page);
  },
};
const { register } = box;
doesNotThrow(register);
test("official", async () => undefined);
`;
const SPREAD_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const base = {
  register() {
    custom("hidden browser test", async ({ page }) => void page);
  },
};
const box = { ...base };
const { register } = box;
doesNotThrow(register);
test("official", async () => undefined);
`;
const COMPUTED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const key = "register";
const box = {
  [key]() {
    custom("hidden browser test", async ({ page }) => void page);
  },
};
const { register } = box;
doesNotThrow(register);
test("official", async () => undefined);
`;
const ASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {};
box.register = () =>
  custom("hidden browser test", async ({ page }) => void page);
const { register } = box;
doesNotThrow(register);
test("official", async () => undefined);
`;
const REASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = { register: 0 };
box.register = () =>
  custom("hidden browser test", async ({ page }) => void page);
const { register } = box;
doesNotThrow(register);
test("official", async () => undefined);
`;
const PROPERTY_ALIAS_NODE_BUILTIN_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  register() {
    custom("hidden browser test", async ({ page }) => void page);
  },
};
const register = box.register;
doesNotThrow(register);
test("official", async () => undefined);
`;
const SHADOWED_PROCESS_ENV_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const process = {
  env: {
    register() {
      custom("hidden browser test", async ({ page }) => void page);
    },
  },
};
const register = process.env.register;
doesNotThrow(register);
test("official", async () => undefined);
`;
const PROCESS_ENV_PROTOTYPE_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
String.prototype.trim = function register() {
  custom("hidden browser test", async ({ page }) => void page);
  return "";
};
const register = process.env.FLAG?.trim;
doesNotThrow(register);
test("official", async () => undefined);
`;
const PROCESS_ENV_CONDITIONAL_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const register = process.env.FLAG
  ? () => custom("hidden browser test", async ({ page }) => void page)
  : undefined;
doesNotThrow(register);
test("official", async () => undefined);
`;
const REPLACED_PROCESS_ENV_CALLBACK_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
process.env = {
  FLAG: (() =>
    custom("hidden browser test", async ({ page }) => void page)) as unknown as string,
};
doesNotThrow(process.env.FLAG as unknown as () => void);
test("official", async () => undefined);
`;
const REPLACED_GLOBAL_PROCESS_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
globalThis.process = {
  env: {
    FLAG: (() =>
      custom("hidden browser test", async ({ page }) => void page)) as unknown as string,
  },
} as unknown as NodeJS.Process;
doesNotThrow(process.env.FLAG as unknown as () => void);
test("official", async () => undefined);
`;
const REPLACED_GLOBAL_COMPUTED_PROCESS_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const root = global;
root["process"] = {
  env: {
    FLAG: (() =>
      custom("hidden browser test", async ({ page }) => void page)) as unknown as string,
  },
} as unknown as NodeJS.Process;
doesNotThrow(process.env.FLAG as unknown as () => void);
test("official", async () => undefined);
`;
const REPLACED_GLOBAL_CONSTANT_KEY_PROCESS_SPEC = `// @playwright-project node-db
import { doesNotThrow } from "node:assert/strict";
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const key = "process" as const;
globalThis[key] = {
  env: {
    FLAG: (() =>
      custom("hidden browser test", async ({ page }) => void page)) as unknown as string,
  },
} as unknown as NodeJS.Process;
doesNotThrow(process.env.FLAG as unknown as () => void);
test("official", async () => undefined);
`;
const SHADOWED_BOOLEAN_CONDITION_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
function Boolean() {
  return true;
}
test.skip(Boolean(false), "shadowed condition");
test("official", async () => undefined);
`;
const REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  get run() {
    custom("custom", async ({ page }) => void page);
    return true;
  },
};
void box.run;
test("official", async () => undefined);
`;
const NESTED_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  nested: {
    get run() {
      custom("custom", async ({ page }) => void page);
      return true;
    },
  },
};
void box.nested.run;
test("official", async () => undefined);
`;
const INLINE_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
void ({
  get run() {
    custom("custom", async ({ page }) => void page);
    return true;
  },
}).run;
test("official", async () => undefined);
`;
const IMPORTED_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { box } from "./getter-fixture";
void box.run;
test("official", async () => undefined);
`;
const DEFINE_PROPERTY_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {};
Object.defineProperty(box, "run", {
  get() {
    custom("custom", async ({ page }) => void page);
    return true;
  },
});
void box.run;
test("official", async () => undefined);
`;
const DESTRUCTURED_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  get run() {
    custom("custom", async ({ page }) => void page);
    return true;
  },
};
const { run } = box;
void run;
test("official", async () => undefined);
`;
const SPREAD_REGISTRATION_GETTER_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const box = {
  get run() {
    custom("custom", async ({ page }) => void page);
    return true;
  },
};
const copy = { ...box };
void copy;
test("official", async () => undefined);
`;
const SPREAD_REGISTRATION_ITERATOR_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
const iterable = {
  *[Symbol.iterator]() {
    custom("custom", async ({ page }) => void page);
  },
};
const copy = [...iterable];
void copy;
test("official", async () => undefined);
`;
const REGISTRATION_TAGGED_TEMPLATE_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { custom } from "./fixtures";
function register() {
  custom("custom", async ({ page }) => void page);
}
register\`custom\`;
test("official", async () => undefined);
`;
const STRING_RAW_TAG_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
const childProcessProbeSource = String.raw\`
  const guardCode = "guard";
\`;
void childProcessProbeSource;
test("official", async () => undefined);
`;
const SHADOWED_STRING_RAW_TAG_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
const String = { raw: (parts: TemplateStringsArray) => parts.raw.join("") };
const source = String.raw\`shadowed\`;
void source;
test("official", async () => undefined);
`;
const IMPORTED_STRING_RAW_TAG_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import { String } from "./fixtures";
const source = String.raw\`imported\`;
void source;
test("official", async () => undefined);
`;
const NAMESPACE_FIXTURE_SPEC = `// @playwright-project node-db
import { test } from "@playwright/test";
import * as fixtures from "./fixtures";
const { custom } = fixtures;
custom("custom", async ({ page }) => void page);
test("official", async () => undefined);
`;
const INLINE_EXTEND_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
const custom = test.extend({ role: async ({}, use) => use("owner") });
custom("custom", async ({ page }) => void page);
`;
const OFFICIAL_TEST_WITH_HELPER_SPEC = `// @playwright-project ui
import { test } from "@playwright/test";
import { ordinaryHelper } from "./ordinary-helper";
test("official", async ({ page }) => {
  ordinaryHelper();
  void page;
});
`;
const PLAYWRIGHT_DEFAULT_UNSUPPORTED_FILENAMES = [
  "unsupported.test.ts",
  "unsupported.spec.tsx",
  "unsupported.test.tsx",
  "unsupported.spec.js",
  "unsupported.test.js",
  "unsupported.spec.jsx",
  "unsupported.test.jsx",
  "unsupported.spec.mjs",
  "unsupported.test.mjs",
  "unsupported.spec.mjsx",
  "unsupported.test.mjsx",
  "unsupported.spec.cjs",
  "unsupported.test.cjs",
  "unsupported.spec.cjsx",
  "unsupported.test.cjsx",
  "unsupported.spec.mts",
  "unsupported.test.mts",
  "unsupported.spec.mtsx",
  "unsupported.test.mtsx",
  "unsupported.spec.cts",
  "unsupported.test.cts",
  "unsupported.spec.ctsx",
  "unsupported.test.ctsx",
] as const;
