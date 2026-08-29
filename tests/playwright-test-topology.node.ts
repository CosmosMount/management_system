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
  NODE_DB_SPEC,
  UI_SPEC,
} from "./helpers/playwright-topology-spec-sources";

test("当前 Playwright spec 唯一归入 30 个 UI 或 46 个 node-db", () => {
  const topology = discoverPlaywrightTestTopology();
  assert.equal(topology.ui.length, 30);
  assert.equal(topology.nodeDb.length, 46);
  assert.equal(new Set([...topology.ui, ...topology.nodeDb]).size, 76);
  assert.ok(
    [...topology.ui, ...topology.nodeDb].every((file) =>
      file.endsWith(".spec.ts"),
    ),
  );
});

test("仅 UI spec 的 topology 因缺少 node-db spec 被拒绝", () => {
  assertIncompleteTopology({ "ui.spec.ts": UI_SPEC });
});

test("仅 node-db spec 的 topology 因缺少 UI spec 被拒绝", () => {
  assertIncompleteTopology({ "node-db.spec.ts": NODE_DB_SPEC });
});

function assertIncompleteTopology(specs: Record<string, string>): void {
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), "playwright-incomplete-topology-"),
  );
  const testRoot = path.join(temporaryRoot, "tests");
  mkdirSync(testRoot);
  try {
    for (const [name, source] of Object.entries(specs)) {
      writeFileSync(path.join(testRoot, name), source, "utf8");
    }
    assert.throws(
      () => discoverPlaywrightTestTopology(temporaryRoot),
      /Playwright topology must contain both ui and node-db specs/,
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}
