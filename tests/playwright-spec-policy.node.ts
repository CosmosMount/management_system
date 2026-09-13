import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverPlaywrightTestTopology } from "../scripts/playwright-test-topology";
import {
  ASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
  BOUND_ALIAS_SPEC,
  CALL_RETURN_ALIAS_SPEC,
  COMPUTED_ALIAS_SPEC,
  COMPUTED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
  COMPUTED_FIXTURE_KEY_SPEC,
  CONDITIONAL_NODE_BUILTIN_CALLBACK_SPEC,
  CONDITIONAL_NODE_BUILTIN_FACTORY_SPEC,
  CONSTRUCTOR_REGISTRATION_HELPER_SPEC,
  CONTAINER_ALIAS_SPEC,
  CUSTOM_FIXTURE_SPEC,
  DEFAULT_PARAMETER_ALIAS_SPEC,
  DEFINE_PROPERTY_REGISTRATION_GETTER_SPEC,
  DESCRIBE_REGISTRATION_HELPER_SPEC,
  DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
  DESTRUCTURED_REGISTRATION_GETTER_SPEC,
  ESCAPED_FIXTURE_UI_SPEC,
  FACTORY_ALIAS_SPEC,
  IMPORTED_REGISTRATION_GETTER_SPEC,
  IMPORTED_STRING_RAW_TAG_SPEC,
  INDIRECT_CALLBACK_SPEC,
  INLINE_EXTEND_SPEC,
  INLINE_REGISTRATION_GETTER_SPEC,
  ISOLATED_GLOBAL_SHADOW_SPEC,
  LOCAL_ALIAS_SPEC,
  NAMESPACE_FIXTURE_SPEC,
  NESTED_REGISTRATION_GETTER_SPEC,
  NODE_BUILTIN_FACTORY_HELPER_SPEC,
  NODE_DB_PROJECT_SKIP_SPEC,
  NODE_DB_SPEC,
  OFFICIAL_TEST_SHADOW_SPEC,
  OFFICIAL_TEST_WITH_HELPER_SPEC,
  PARAMETER_ALIAS_SPEC,
  PLAYWRIGHT_DEFAULT_UNSUPPORTED_FILENAMES,
  PROCESS_ENV_CONDITIONAL_CALLBACK_SPEC,
  PROCESS_ENV_PROTOTYPE_CALLBACK_SPEC,
  PROMISE_REGISTRATION_HELPER_SPEC,
  PROPERTY_ALIAS_NODE_BUILTIN_CALLBACK_SPEC,
  REASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
  REGISTRATION_GETTER_SPEC,
  REGISTRATION_HELPER_SPEC,
  REGISTRATION_TAGGED_TEMPLATE_SPEC,
  RENAMED_CUSTOM_FIXTURE_SPEC,
  REPLACED_GLOBAL_COMPUTED_PROCESS_SPEC,
  REPLACED_GLOBAL_CONSTANT_KEY_PROCESS_SPEC,
  REPLACED_GLOBAL_PROCESS_SPEC,
  REPLACED_PROCESS_ENV_CALLBACK_SPEC,
  SAFE_GLOBAL_REGISTRATION_HELPER_SPEC,
  SHADOWED_ALIAS_GLOBAL_SPEC,
  SHADOWED_BOOLEAN_CONDITION_SPEC,
  SHADOWED_CONSTRUCTOR_GLOBAL_SPEC,
  SHADOWED_FUNCTION_GLOBAL_SPEC,
  SHADOWED_NODE_BUILTIN_ALIAS_SPEC,
  SHADOWED_NODE_BUILTIN_FUNCTION_SPEC,
  SHADOWED_PROCESS_ENV_CALLBACK_SPEC,
  SHADOWED_STRING_RAW_TAG_SPEC,
  SPREAD_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
  SPREAD_REGISTRATION_GETTER_SPEC,
  SPREAD_REGISTRATION_ITERATOR_SPEC,
  STRING_RAW_TAG_SPEC,
  SUITE_MAP_CONSTRUCTOR_SPEC,
  SUPPORTED_PLAYWRIGHT_API_SPEC,
  UI_ALIAS_SPEC,
  UI_SPEC,
  WRAPPED_NODE_BUILTIN_CALLBACK_SPEC,
  conditionalAnnotationSpec,
  indirectConditionalAnnotationSpec,
  wrappedConditionalAnnotationSpec,
} from "./helpers/playwright-topology-spec-sources";

test("Playwright 分类与 AST/spec policy 对不可信写法 fail closed", () => {
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
      NODE_DB_SPEC.replace(
        "@playwright-project node-db",
        "@playwright-project ui",
      ),
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /declares ui but uses no browser fixture/,
    );
    removeSpec("wrong-ui.spec.ts");

    writeSpec("wrong-project-skip.spec.ts", NODE_DB_PROJECT_SKIP_SPEC);
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /declares node-db but skips a UI project/,
    );
    removeSpec("wrong-project-skip.spec.ts");

    writeSpec("alias-ui.spec.ts", UI_ALIAS_SPEC);
    assert.ok(
      discoverPlaywrightTestTopology(temporaryRoot).ui.includes(
        "alias-ui.spec.ts",
      ),
    );
    removeSpec("alias-ui.spec.ts");

    writeSpec(
      "alias-node-db.spec.ts",
      UI_ALIAS_SPEC.replace(
        "@playwright-project ui",
        "@playwright-project node-db",
      ),
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

    writeSpec(
      "supported-playwright-api.spec.ts",
      SUPPORTED_PLAYWRIGHT_API_SPEC,
    );
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
      [
        "safe-global-registration-helper.spec.ts",
        SAFE_GLOBAL_REGISTRATION_HELPER_SPEC,
      ],
      ["promise-registration-helper.spec.ts", PROMISE_REGISTRATION_HELPER_SPEC],
      [
        "constructor-registration-helper.spec.ts",
        CONSTRUCTOR_REGISTRATION_HELPER_SPEC,
      ],
      ["shadowed-function-global.spec.ts", SHADOWED_FUNCTION_GLOBAL_SPEC],
      ["shadowed-alias-global.spec.ts", SHADOWED_ALIAS_GLOBAL_SPEC],
      ["shadowed-constructor-global.spec.ts", SHADOWED_CONSTRUCTOR_GLOBAL_SPEC],
      [
        "shadowed-node-builtin-function.spec.ts",
        SHADOWED_NODE_BUILTIN_FUNCTION_SPEC,
      ],
      ["shadowed-node-builtin-alias.spec.ts", SHADOWED_NODE_BUILTIN_ALIAS_SPEC],
      ["node-builtin-factory-helper.spec.ts", NODE_BUILTIN_FACTORY_HELPER_SPEC],
      [
        "wrapped-node-builtin-callback.spec.ts",
        WRAPPED_NODE_BUILTIN_CALLBACK_SPEC,
      ],
      [
        "conditional-node-builtin-factory.spec.ts",
        CONDITIONAL_NODE_BUILTIN_FACTORY_SPEC,
      ],
      [
        "conditional-node-builtin-callback.spec.ts",
        CONDITIONAL_NODE_BUILTIN_CALLBACK_SPEC,
      ],
      [
        "destructured-node-builtin-callback.spec.ts",
        DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
      ],
      [
        "spread-destructured-node-builtin-callback.spec.ts",
        SPREAD_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
      ],
      [
        "computed-destructured-node-builtin-callback.spec.ts",
        COMPUTED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
      ],
      [
        "assigned-destructured-node-builtin-callback.spec.ts",
        ASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
      ],
      [
        "reassigned-destructured-node-builtin-callback.spec.ts",
        REASSIGNED_DESTRUCTURED_NODE_BUILTIN_CALLBACK_SPEC,
      ],
      [
        "property-alias-node-builtin-callback.spec.ts",
        PROPERTY_ALIAS_NODE_BUILTIN_CALLBACK_SPEC,
      ],
      [
        "shadowed-process-env-callback.spec.ts",
        SHADOWED_PROCESS_ENV_CALLBACK_SPEC,
      ],
      [
        "process-env-prototype-callback.spec.ts",
        PROCESS_ENV_PROTOTYPE_CALLBACK_SPEC,
      ],
      [
        "process-env-conditional-callback.spec.ts",
        PROCESS_ENV_CONDITIONAL_CALLBACK_SPEC,
      ],
    ] as const) {
      writeSpec(filename, source);
      assert.throws(
        () => discoverPlaywrightTestTopology(temporaryRoot),
        /untrusted call while registering tests/,
      );
      removeSpec(filename);
    }

    writeSpec(
      "replaced-process-env-callback.spec.ts",
      REPLACED_PROCESS_ENV_CALLBACK_SPEC,
    );
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /replaces global process or process\.env while registering tests/,
    );
    removeSpec("replaced-process-env-callback.spec.ts");

    for (const [filename, source] of [
      ["replaced-global-process.spec.ts", REPLACED_GLOBAL_PROCESS_SPEC],
      [
        "replaced-global-computed-process.spec.ts",
        REPLACED_GLOBAL_COMPUTED_PROCESS_SPEC,
      ],
      [
        "replaced-global-constant-key-process.spec.ts",
        REPLACED_GLOBAL_CONSTANT_KEY_PROCESS_SPEC,
      ],
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
      [
        "imported-registration-getter.spec.ts",
        IMPORTED_REGISTRATION_GETTER_SPEC,
      ],
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
        new RegExp(
          `${unsupportedFilename.replaceAll(".", "\\.")}.*only supports \\.spec\\.ts`,
        ),
      );
      removeSpec(unsupportedFilename);
    }

  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
