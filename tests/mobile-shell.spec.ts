// @playwright-project ui
import { expect, test } from "@playwright/test";
import {
  ensureFallbackAdminFixture, expectHealthyPage, loginAsAdminUser, loginAsTestUser,
} from "./helpers/functional-fixtures";
import { createAccountPerson } from "./helpers/project-management-ui-fixtures";
import { resolveFeishuIdentityForUser } from "../lib/project-management/identity";

test("全站导航在桌面和手机断点保持完整且主内容真正适配", async ({ context, page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ensureFallbackAdminFixture();
  await loginAsAdminUser(context, baseURL);
  await page.goto("/");
  for (const width of [1440, 1024, 1023, 768, 767, 430, 393, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 851 });
    await expectHealthyPage(page);
    const header = await page.getByTestId("app-header").boundingBox();
    expect(header).not.toBeNull();
    expect(header!.x + header!.width).toBeLessThanOrEqual(width + 1);
    if (width < 1024) {
      await expect(page.getByRole("contentinfo", { name: "前端版本" })).toHaveCSS("position", "relative");
      const trigger = page.getByRole("button", { name: "打开系统导航" });
      await trigger.click();
      const drawer = page.getByRole("dialog", { name: "系统导航", exact: true });
      await expect(drawer).toBeVisible();
      for (const name of ["首页", "采购管理", "物资", "项目管理", "个人中心", "管理员面板", "反馈"]) {
        await expect(drawer.getByRole("link", { name, exact: true })).toBeVisible();
      }
      if (width === 393) await page.screenshot({ path: testInfo.outputPath("system-navigation-393.png"), animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(trigger).toBeFocused();
    } else {
      await expect(page.getByRole("button", { name: "打开系统导航" })).toBeHidden();
      await expect(page.getByRole("navigation", { name: "系统导航" })).toBeVisible();
    }
    if ([1440, 393, 360].includes(width)) await page.screenshot({ path: testInfo.outputPath(`home-${width}.png`), fullPage: true, animations: "disabled" });
  }

  await page.setViewportSize({ width: 393, height: 851 });
  await page.goto("/procurement/pending");
  const main = page.getByRole("main");
  expect(await main.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(393);
  expect(await main.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "打开采购管理导航" }).click();
  const moduleDrawer = page.getByRole("dialog", { name: "采购管理导航", exact: true });
  await expect(moduleDrawer.getByRole("link", { name: "待办与最近", exact: true })).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: testInfo.outputPath("module-navigation-393.png"), animations: "disabled" });
  await moduleDrawer.getByRole("link", { name: "订单列表", exact: true }).click();
  await expect(page).toHaveURL(/\/procurement\/list$/);
  await expect(moduleDrawer).toBeHidden();
  await expectHealthyPage(page);

  await page.getByRole("button", { name: "打开采购管理导航" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByTestId("procurement-sidebar")).toBeVisible();
  await page.setViewportSize({ width: 393, height: 851 });
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.goto("/progress/tasks?q=手机导航");
  await page.getByRole("button", { name: "打开项目管理导航" }).click();
  await page.getByRole("dialog", { name: "项目管理导航", exact: true }).getByRole("link", { name: "任务", exact: true }).click();
  await expect(page).toHaveURL(/\/progress\/tasks$/);
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(errors).toEqual([]);
});

test("普通用户手机导航保留业务入口但不显示管理员权限", async ({ context, page, baseURL }, testInfo) => {
  const user = await createAccountPerson("手机导航长姓名".repeat(10));
  await resolveFeishuIdentityForUser({ openId: user.openId, name: user.person.displayName, unionId: null });
  await loginAsTestUser(context, baseURL, { openId: user.openId, name: user.person.displayName });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.getByRole("button", { name: "打开系统导航" }).click();
  const drawer = page.getByRole("dialog", { name: "系统导航", exact: true });
  await expect(drawer.getByRole("link", { name: "管理员面板" })).toHaveCount(0);
  await drawer.getByRole("link", { name: "个人中心", exact: true }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expectHealthyPage(page);
  await page.screenshot({ path: testInfo.outputPath("profile-long-name-360.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "打开系统导航" }).click();
  await drawer.getByRole("link", { name: "个人中心", exact: true }).click();
  await expect(drawer).toBeHidden();
});

test.describe("手机触摸导航", () => {
  test.use({ hasTouch: true, viewport: { width: 393, height: 851 } });

  test("触摸目标和登录入口可达", async ({ context, page, baseURL }, testInfo) => {
    await page.goto("/login");
    const login = page.getByRole("button", { name: "飞书登录" });
    const loginBox = await login.boundingBox();
    expect(loginBox!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath("login-touch-393.png"), animations: "disabled" });
    await ensureFallbackAdminFixture();
    await loginAsAdminUser(context, baseURL);
    await page.goto("/materials");
    await page.getByRole("button", { name: "打开系统导航" }).tap();
    const drawer = page.getByRole("dialog", { name: "系统导航", exact: true });
    const projectLink = drawer.getByRole("link", { name: "项目管理", exact: true });
    await expect.poll(async () => (await projectLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await drawer.getByRole("button", { name: "关闭系统导航" }).tap();
    await expect(drawer).toBeHidden();
    await expectHealthyPage(page);
    await page.goto("/admin/accounts");
    const accountPicker = page.getByRole("combobox", { name: "展开选择要配置角色的用户", exact: true });
    expect((await accountPicker.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await accountPicker.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    await accountPicker.tap();
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("account-picker-touch-393.png"), animations: "disabled" });
    await page.keyboard.press("Escape");
  });
});
