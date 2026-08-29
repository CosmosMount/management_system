import fs from "node:fs";
import path from "node:path";
import { analyzePlaywrightSpec } from "./playwright-spec-policy";

export {
  PLAYWRIGHT_PROJECT_NAMES,
  playwrightProjectSelection,
  playwrightTopologySelectionMode,
  selectedPlaywrightProjectNames,
} from "./playwright-cli-selection";
export type {
  PlaywrightProjectSelection,
  PlaywrightTopologySelectionMode,
} from "./playwright-cli-selection";

export type PlaywrightTestKind = "node-db" | "ui";

export const PLAYWRIGHT_TOPOLOGY_SELECTION_MODE_ENV =
  "PLAYWRIGHT_TOPOLOGY_SELECTION_MODE";

export type PlaywrightTestTopology = {
  nodeDb: string[];
  ui: string[];
};

const DECLARATION_PATTERN = /^\/\/ @playwright-project (node-db|ui)$/gm;
const PLAYWRIGHT_DEFAULT_TEST_FILE_PATTERN =
  /\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/;

function walkSpecFiles(directory: string, testRoot: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSpecFiles(absolutePath, testRoot));
      continue;
    }
    if (
      !entry.isFile() ||
      !PLAYWRIGHT_DEFAULT_TEST_FILE_PATTERN.test(entry.name)
    ) {
      continue;
    }
    if (!entry.name.endsWith(".spec.ts")) {
      const relativePath = path
        .relative(testRoot, absolutePath)
        .split(path.sep)
        .join("/");
      throw new Error(
        `${relativePath} matches Playwright's default test filename rules but topology classification only supports .spec.ts; rename the file before running Playwright`,
      );
    }
    files.push(absolutePath);
  }
  return files.sort();
}

function declaredKind(
  source: string,
  relativePath: string,
): PlaywrightTestKind {
  const declarations = [...source.matchAll(DECLARATION_PATTERN)];
  if (declarations.length !== 1 || declarations[0]?.index !== 0) {
    throw new Error(
      `${relativePath} must start with exactly one // @playwright-project ui|node-db declaration`,
    );
  }
  return declarations[0][1] as PlaywrightTestKind;
}

export function discoverPlaywrightTestTopology(
  repositoryRoot = process.cwd(),
): PlaywrightTestTopology {
  const testRoot = path.join(repositoryRoot, "tests");
  const topology: PlaywrightTestTopology = { nodeDb: [], ui: [] };

  for (const absolutePath of walkSpecFiles(testRoot, testRoot)) {
    const relativePath = path
      .relative(testRoot, absolutePath)
      .split(path.sep)
      .join("/");
    const source = fs.readFileSync(absolutePath, "utf8");
    const kind = declaredKind(source, relativePath);
    const analysis = analyzePlaywrightSpec(source, relativePath);
    if (kind === "ui" && !analysis.usesBrowserFixture) {
      throw new Error(
        `${relativePath} declares ui but uses no browser fixture`,
      );
    }
    if (kind === "node-db" && analysis.usesBrowserFixture) {
      throw new Error(
        `${relativePath} declares node-db but uses a browser fixture`,
      );
    }
    if (kind === "node-db" && analysis.usesDeviceProjectSkip) {
      throw new Error(
        `${relativePath} declares node-db but skips a desktop or mobile project`,
      );
    }
    topology[kind === "ui" ? "ui" : "nodeDb"].push(relativePath);
  }

  if (topology.nodeDb.length === 0 || topology.ui.length === 0) {
    throw new Error("Playwright topology must contain both ui and node-db specs");
  }

  return topology;
}
