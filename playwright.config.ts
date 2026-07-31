import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";
import { installPlaywrightFeishuEgressGuard } from "./scripts/playwright-feishu-egress-guard.mjs";
import { assertOfficialPlaywrightEnvironment } from "./scripts/playwright-runner";

const ownership = assertOfficialPlaywrightEnvironment(process.env);
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
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
