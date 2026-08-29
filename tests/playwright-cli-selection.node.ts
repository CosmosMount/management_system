import assert from "node:assert/strict";
import test from "node:test";
import {
  playwrightProjectSelection,
  playwrightTopologySelectionMode,
  selectedPlaywrightProjectNames,
} from "../scripts/playwright-test-topology";

test("Playwright CLI selection 区分全集、局部和项目过滤并 fail closed", () => {
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
    selectedPlaywrightProjectNames(["node-db", "desktop", "mobile"], ["d*"]),
    ["desktop"],
  );
  assert.deepEqual(
    selectedPlaywrightProjectNames(["node-db", "desktop", "mobile"], ["*"]),
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
      selectedPlaywrightProjectNames(["node-db", "desktop", "mobile"], ["z*"]),
    /No projects matched/,
  );
});
