import { expect, test } from "@playwright/test";

test("根布局容忍浏览器扩展在 hydration 前注入 html 属性", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.route("**/login", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const html = await response.text();
    await route.fulfill({
      response,
      body: html.replace(
        "<html",
        '<html data-immersive-translate-page-theme="light"',
      ),
    });
  });

  await page.goto("/login", { waitUntil: "networkidle" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-immersive-translate-page-theme",
    "light",
  );
  expect(
    browserErrors.filter(
      (message) =>
        !message.includes("/_next/webpack-hmr") ||
        !message.includes("ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS"),
    ),
  ).toEqual([]);
});
