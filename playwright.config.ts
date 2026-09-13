import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";
import { installPlaywrightFeishuEgressGuard } from "./scripts/playwright-feishu-egress-guard.mjs";
import { assertOfficialPlaywrightEnvironment } from "./scripts/playwright-runner";
import {
  discoverPlaywrightTestTopology,
  PLAYWRIGHT_TOPOLOGY_SELECTION_MODE_ENV,
} from "./scripts/playwright-test-topology";

const ownership = assertOfficialPlaywrightEnvironment(process.env);
const topology = discoverPlaywrightTestTopology();
const topologySelectionMode =
  process.env[PLAYWRIGHT_TOPOLOGY_SELECTION_MODE_ENV];
if (topologySelectionMode !== "full" && topologySelectionMode !== "partial") {
  throw new Error(
    `${PLAYWRIGHT_TOPOLOGY_SELECTION_MODE_ENV}=full|partial is required`,
  );
}
const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL) {
  throw new Error("PLAYWRIGHT_BASE_URL is required");
}

installPlaywrightFeishuEgressGuard();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  metadata: {
    playwrightTargetDatabaseName: ownership.target.databaseName,
    playwrightShadowDatabaseName: ownership.shadow.databaseName,
  },
  reporter: [
    [process.env.CI ? "dot" : "list"],
    ["./scripts/playwright-topology-reporter.ts", { selectionMode: topologySelectionMode }],
  ],
  projects: [
    {
      name: "node-db",
      testMatch: topology.nodeDb,
    },
    {
      name: "desktop",
      testMatch: topology.ui,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
});
