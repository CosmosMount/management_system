import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100";
const parsedBaseUrl = new URL(baseURL);

if (parsedBaseUrl.port === "3000") {
  throw new Error("Playwright must not target port 3000. Use PLAYWRIGHT_BASE_URL with an isolated test port.");
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : {
        command: `PLAYWRIGHT_DATABASE_URL=${shellQuote(testDatabaseUrl)} npx tsx scripts/setup-playwright-db.ts && DATABASE_URL=${shellQuote(testDatabaseUrl)} npm run db:deploy && DATABASE_URL=${shellQuote(testDatabaseUrl)} npm run db:seed && DATABASE_URL=${shellQuote(testDatabaseUrl)} npm run db:seed-acceptance-checklists && DATABASE_URL=${shellQuote(testDatabaseUrl)} npm run db:seed-progress-reminders && DATABASE_URL=${shellQuote(testDatabaseUrl)} npm run dev -- -p ${parsedBaseUrl.port || "3100"}`,
        url: baseURL,
        reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === "true",
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
