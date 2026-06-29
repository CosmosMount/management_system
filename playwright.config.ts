import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3002";
const parsedBaseUrl = new URL(baseURL);

if (
  parsedBaseUrl.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "::1"].includes(parsedBaseUrl.hostname) ||
  parsedBaseUrl.port !== "3002"
) {
  throw new Error(
    "Playwright must target http://127.0.0.1:3002 or http://localhost:3002 only.",
  );
}

function deriveDatabaseUrl(baseUrl: string | undefined, suffix: string): string | undefined {
  if (!baseUrl) return undefined;
  const url = new URL(baseUrl);
  const databaseName = url.pathname.replace(/^\//, "");
  if (!databaseName) return undefined;
  url.pathname = `/${databaseName}${suffix}`;
  return url.toString();
}

const testDatabaseUrl =
  process.env.PLAYWRIGHT_DATABASE_URL ??
  deriveDatabaseUrl(process.env.DATABASE_URL, "_test") ??
  "postgresql://postgres:replace-with-a-strong-password@127.0.0.1:5432/management_system_test";

if (process.env.PLAYWRIGHT_REUSE_SERVER === "true") {
  throw new Error(
    "PLAYWRIGHT_REUSE_SERVER is disabled because tests must start a controlled server with NOTIFICATION_DELIVERY_DISABLED=true.",
  );
}

if (process.env.PLAYWRIGHT_SKIP_WEBSERVER) {
  throw new Error(
    "PLAYWRIGHT_SKIP_WEBSERVER is disabled because tests must start a controlled server with NOTIFICATION_DELIVERY_DISABLED=true.",
  );
}

delete process.env.NO_COLOR;
delete process.env.FORCE_COLOR;
process.env.DATABASE_URL = testDatabaseUrl;
process.env.PLAYWRIGHT_DATABASE_URL = testDatabaseUrl;

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
  webServer: {
    command: `tsx scripts/start-playwright-server.ts`,
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl,
      PLAYWRIGHT_DATABASE_URL: testDatabaseUrl,
      PLAYWRIGHT_SERVER_PORT: parsedBaseUrl.port || "3002",
      PLAYWRIGHT_CONFIRM_RECREATE_DB:
        new URL(testDatabaseUrl).pathname.replace(/^\//, ""),
      NOTIFICATION_DELIVERY_DISABLED: "true",
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
