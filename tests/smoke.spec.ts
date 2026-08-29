// @playwright-project ui
import { existsSync } from "fs";
import { expect, test } from "@playwright/test";

const protectedRoutes = [
  "/",
  "/admin",
  "/admin/budget-pools",
  "/admin/system",
  "/feedback",
  "/procurement",
  "/procurement/dashboard",
  "/procurement/list",
  "/procurement/new",
  "/profile",
  "/progress",
];

const authenticatedRoutes = [
  "/",
  "/feedback",
  "/procurement",
  "/procurement/dashboard",
  "/procurement/list",
  "/procurement/new",
  "/profile",
  "/progress",
];

const privilegedRoutes = [
  "/admin",
  "/admin/budget-pools",
  "/admin/system",
];

const authStorageState = process.env.PLAYWRIGHT_STORAGE_STATE;
const hasAuthStorageState = Boolean(
  authStorageState && existsSync(authStorageState),
);
const adminStorageState = process.env.PLAYWRIGHT_ADMIN_STORAGE_STATE;
const hasAdminStorageState = Boolean(
  adminStorageState && existsSync(adminStorageState),
);

async function expectHealthyPage(page: import("@playwright/test").Page) {
  await expect(page.locator("body")).toBeVisible();
  await expect(page.getByText(/Application error|Internal Server Error|Unhandled Runtime Error/i)).toHaveCount(0);

  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - window.innerWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

async function collectBrowserErrors(page: import("@playwright/test").Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  return errors;
}

test.describe("public and unauthenticated smoke", () => {
  for (const route of protectedRoutes) {
    test(`route ${route} renders without server error`, async ({ page }) => {
      const errors = await collectBrowserErrors(page);

      const response = await page.goto(route, { waitUntil: "networkidle" });
      expect(response?.status() ?? 0).toBeLessThan(500);
      await expectHealthyPage(page);
      expect(errors).toEqual([]);
    });
  }

  test("unknown route shows 404 experience without crashing", async ({ page }) => {
    const errors = await collectBrowserErrors(page);
    const response = await page.goto("/not-exists-for-playwright", {
      waitUntil: "networkidle",
    });
    expect(response?.status() ?? 0).toBeLessThan(500);
    await expectHealthyPage(page);
    expect(errors).toEqual([]);
  });

  test("uploads are not publicly readable", async ({ request }) => {
    const response = await request.get("/uploads/playwright-missing-file.png", {
      maxRedirects: 0,
    });
    expect([301, 302, 303, 307, 308, 401, 404]).toContain(response.status());
  });
});

test.describe("authenticated smoke", () => {
  test.skip(
    !hasAuthStorageState,
    "Set PLAYWRIGHT_STORAGE_STATE=.tmp/<storage>.json to run authenticated smoke tests.",
  );
  test.use(authStorageState ? { storageState: authStorageState } : {});

  for (const route of authenticatedRoutes) {
    test(`authenticated route ${route} is reachable`, async ({ page }) => {
      const errors = await collectBrowserErrors(page);
      const response = await page.goto(route, { waitUntil: "networkidle" });

      expect(response?.status() ?? 0).toBeLessThan(500);
      await expectHealthyPage(page);
      await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
      expect(errors).toEqual([]);
    });
  }

  test("feedback filters and selected query stay stable", async ({ page }) => {
    const errors = await collectBrowserErrors(page);

    const response = await page.goto("/feedback", { waitUntil: "networkidle" });
    expect(response?.status() ?? 0).toBeLessThan(500);
    await expectHealthyPage(page);

    const allFilter = page.getByRole("button", { name: /^全部/ }).first();
    if (await allFilter.isVisible()) {
      await allFilter.click();
    }

    const firstFeedback = page.locator("button.w-full.text-left").first();
    if (await firstFeedback.isVisible()) {
      const beforeUrl = page.url();
      await firstFeedback.click();
      await page.waitForLoadState("networkidle");
      await expectHealthyPage(page);
      if (page.url() !== beforeUrl) {
        expect(new URL(page.url()).searchParams.has("selected")).toBe(true);
      }
    }

    expect(errors).toEqual([]);
  });

  test("progress workspace and retired routes stay healthy", async ({ page }) => {
    const errors = await collectBrowserErrors(page);
    await page.goto("/progress", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();

    const legacyTaskResponse = await page.goto("/progress/task/legacy-task", {
      waitUntil: "networkidle",
    });
    expect(legacyTaskResponse?.status()).toBe(404);
    await expect(page).toHaveURL(/\/progress\/task\/legacy-task$/);
    await expect(
      page.getByRole("heading", { name: "页面不存在或无权访问" }),
    ).toBeVisible();
    await expectHealthyPage(page);

    const legacyKanbanResponse = await page.goto("/progress/kanban", { waitUntil: "networkidle" });
    expect(legacyKanbanResponse?.status()).toBe(404);
    await expect(page).toHaveURL(/\/progress\/kanban$/);
    await expect(page.getByRole("heading", { name: "页面不存在或无权访问" })).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/progress/projects/legacy-project", {
      waitUntil: "networkidle",
    });
    await expect(page).toHaveURL(/\/progress\/projects\/legacy-project$/);
    await expect(page.getByRole("heading", { name: "页面不存在或无权访问" })).toBeVisible();
    await expectHealthyPage(page);

    expect(errors).toEqual([]);
  });
});

test.describe("privileged authenticated smoke", () => {
  test.skip(
    !hasAdminStorageState,
    "Set PLAYWRIGHT_ADMIN_STORAGE_STATE=.tmp/<admin-storage>.json to run privileged smoke tests.",
  );
  test.use(adminStorageState ? { storageState: adminStorageState } : {});

  for (const route of privilegedRoutes) {
    test(`privileged route ${route} is reachable`, async ({ page }) => {
      const errors = await collectBrowserErrors(page);
      const response = await page.goto(route, { waitUntil: "networkidle" });

      expect(response?.status() ?? 0).toBeLessThan(500);
      await expectHealthyPage(page);
      await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
      await expect(page.getByText("页面不存在或无权访问")).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }

  test("retired admin roles route returns 404", async ({ page }) => {
    const response = await page.goto("/admin/roles", { waitUntil: "networkidle" });
    expect(response?.status()).toBe(404);
    await expect(page).toHaveURL(/\/admin\/roles$/);
    await expectHealthyPage(page);
  });
});
