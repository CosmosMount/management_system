import { expect, test } from "@playwright/test";

const protectedRoutes = [
  "/",
  "/feedback",
  "/progress",
  "/progress/list",
  "/progress/dashboard",
  "/procurement",
];

async function expectHealthyPage(page: import("@playwright/test").Page) {
  await expect(page.getByText(/Application error|Internal Server Error|Unhandled Runtime Error/i)).toHaveCount(0);

  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - window.innerWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

for (const route of protectedRoutes) {
  test(`route ${route} renders without server error`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    const response = await page.goto(route, { waitUntil: "networkidle" });
    expect(response?.status() ?? 0).toBeLessThan(500);
    await expectHealthyPage(page);
    expect(errors).toEqual([]);
  });
}

test("unknown route shows 404 experience without crashing", async ({ page }) => {
  const response = await page.goto("/not-exists-for-playwright", {
    waitUntil: "networkidle",
  });
  expect(response?.status() ?? 0).toBeLessThan(500);
  await expectHealthyPage(page);
});
