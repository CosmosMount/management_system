// @playwright-project ui
import { expect, test } from "@playwright/test";
import { FRONTEND_VERSION } from "../lib/frontend-version";
import { createAccountPerson, grantGlobalProjectAdministrator } from "./helpers/project-management-canvas-security-fixtures";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

test("前端版本公开只读、禁止缓存，清理入口仅允许本站请求且不清登录和存储", async ({ page, request, baseURL }) => {
  const response = await request.get("/api/frontend-version");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ version: FRONTEND_VERSION });
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["clear-site-data"]).toBeUndefined();
  const denied = await request.post("/api/frontend-version", { headers: { origin: "https://untrusted.example", "x-frontend-version-refresh": "1" } });
  expect(denied.status()).toBe(403);
  expect(denied.headers()["clear-site-data"]).toBeUndefined();
  const missingHeader = await request.post("/api/frontend-version", { headers: { origin: baseURL! } });
  expect(missingHeader.status()).toBe(403);
  const allowed = await request.post("/api/frontend-version", { headers: { origin: baseURL!, "x-frontend-version-refresh": "1" } });
  expect(allowed.ok()).toBe(true);
  expect(allowed.headers()["clear-site-data"]).toBe('"cache"');
  await page.goto("/login");
  await expect(page.getByLabel("前端版本")).toContainText(`前端 v${FRONTEND_VERSION}`);
  await expect(page.locator('meta[name="frontend-version"]')).toHaveAttribute("content", FRONTEND_VERSION);
  await expectHealthyPage(page);
});

test("发现新版本自动整页更新，保留参数和站点数据，旧资源不会循环刷新", async ({ page, context, baseURL }) => {
  const nextVersion = FRONTEND_VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.clock.install({ time: Date.now() });
  await context.addCookies([{ name: "frontend-version-cookie", value: "keep", url: baseURL! }]);
  await page.addInitScript(() => {
    if (!new URL(location.href).searchParams.has("__frontend_version")) {
      localStorage.setItem("frontend-version-draft", "保留草稿");
      sessionStorage.setItem("frontend-version-session", "保留会话数据");
    }
  });
  let refreshCount = 0;
  await page.route("**/api/frontend-version?*", async (route) => {
    if (route.request().method() === "POST") {
      refreshCount += 1;
      expect(route.request().headers()["x-frontend-version-refresh"]).toBe("1");
    }
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store", ...(route.request().method() === "POST" ? { "Clear-Site-Data": '"cache"' } : {}) }, body: JSON.stringify({ version: nextVersion }) });
  });
  await page.goto("/login?callbackUrl=%2Fprogress%2Fprojects#keep-anchor");
  await expect(page).toHaveURL((url) => url.searchParams.get("__frontend_version") === nextVersion);
  await expect(page.getByRole("status")).toContainText("已停止自动重刷");
  const current = new URL(page.url());
  expect(current.searchParams.get("callbackUrl")).toBe("/progress/projects");
  expect(current.hash).toBe("#keep-anchor");
  await page.clock.fastForward(180_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("status")).toContainText("已停止自动重刷");
  expect(refreshCount).toBe(1);
  expect((await context.cookies()).find((cookie) => cookie.name === "frontend-version-cookie")?.value).toBe("keep");
  expect(await page.evaluate(() => localStorage.getItem("frontend-version-draft"))).toBe("保留草稿");
  expect(await page.evaluate(() => sessionStorage.getItem("frontend-version-session"))).toBe("保留会话数据");
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("编辑中的项目草稿不会因版本变化被刷新丢失，取消手动更新保留输入", async ({ page, context, baseURL }) => {
  const nextVersion = FRONTEND_VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  const owner = await createAccountPerson("前端升级草稿保护");
  await grantGlobalProjectAdministrator(owner.account.id);
  let version = FRONTEND_VERSION;
  let refreshCount = 0;
  await page.route("**/api/frontend-version?*", async (route) => {
    if (route.request().method() === "POST") refreshCount += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version }) });
  });
  await loginAsTestUser(context, baseURL, { openId: owner.openId, name: owner.person.displayName });
  await page.goto("/progress/projects/new");
  const name = page.getByRole("textbox", { name: "项目名称", exact: true });
  await name.fill("尚未保存的版本升级草稿");
  await page.getByRole("heading", { name: "提交项目立项" }).click();
  version = nextVersion;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("status")).toContainText("请先保存内容");
  await expect(name).toHaveValue("尚未保存的版本升级草稿");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "刷新到新版本" }).click();
  await expect(name).toHaveValue("尚未保存的版本升级草稿");
  expect(refreshCount).toBe(0);
  expect(new URL(page.url()).searchParams.has("__frontend_version")).toBe(false);
  await page.getByRole("button", { name: "稍后更新" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(name).toHaveValue("尚未保存的版本升级草稿");
  await expectHealthyPage(page);
});

test("版本检查离线或收到异常内容时保留当前页面，不清缓存或导航", async ({ page }) => {
  let checks = 0;
  await page.route("**/api/frontend-version?*", async (route) => {
    checks += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: "https://untrusted.example" }) });
  });
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "检查更新" })).toHaveAttribute("title", "暂时无法检查更新，请稍后重试。");
  expect(checks).toBeGreaterThan(0);
  await page.unroute("**/api/frontend-version?*");
  await page.route("**/api/frontend-version?*", (route) => route.abort());
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByRole("button", { name: "检查更新" })).toHaveAttribute("title", "暂时无法检查更新，请稍后重试。");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("status")).toHaveCount(0);
  await expectHealthyPage(page);
});

test("清缓存请求期间开始编辑时取消自动导航，不丢失新输入", async ({ page, context, baseURL }) => {
  const nextVersion = FRONTEND_VERSION.replace(/\d+$/, (patch) => String(Number(patch) + 1));
  const owner = await createAccountPerson("版本检查并发编辑保护");
  await grantGlobalProjectAdministrator(owner.account.id);
  let releaseRefresh: () => void = () => {};
  const refreshHeld = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let refreshCount = 0;
  await page.route("**/api/frontend-version?*", async (route) => {
    if (route.request().method() === "POST") {
      refreshCount += 1;
      await refreshHeld;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: nextVersion }) });
  });
  await loginAsTestUser(context, baseURL, { openId: owner.openId, name: owner.person.displayName });
  await page.goto("/progress/projects/new");
  try {
    await expect.poll(() => refreshCount).toBe(1);
    const name = page.getByRole("textbox", { name: "项目名称", exact: true });
    await name.fill("请求期间新输入的项目名称");
    releaseRefresh();
    await expect(page.getByRole("status")).toContainText("更新期间检测到操作，已暂停刷新");
    await expect(name).toHaveValue("请求期间新输入的项目名称");
    expect(new URL(page.url()).searchParams.has("__frontend_version")).toBe(false);
    await expectHealthyPage(page);
  } finally {
    releaseRefresh();
  }
});
