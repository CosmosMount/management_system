import { expect, test } from "@playwright/test";
import {
  loginAsNormalUser,
  resolveNormalAuthMaterial,
} from "./helpers/functional-fixtures";
import { isControlledPlaywrightServer } from "../lib/playwright-fixture-guard";

test("加工商 fixture 在非受控环境关闭", () => {
  const token = process.env.PLAYWRIGHT_DB_OWNERSHIP_TOKEN;
  delete process.env.PLAYWRIGHT_DB_OWNERSHIP_TOKEN;
  try {
    expect(isControlledPlaywrightServer()).toBe(false);
  } finally {
    if (token === undefined) delete process.env.PLAYWRIGHT_DB_OWNERSHIP_TOKEN;
    else process.env.PLAYWRIGHT_DB_OWNERSHIP_TOKEN = token;
  }
});

test("慢列表响应不会覆盖期间新增加工商", async ({
  page,
  context,
  baseURL,
}) => {
  const auth = await resolveNormalAuthMaterial();
  await loginAsNormalUser(context, baseURL, auth);
  await page.goto("/procurement/vendor-hook-fixtures");
  await page.getByRole("button", { name: "新增加工商" }).click();
  await expect(page.getByLabel("加工商列表")).toContainText("新增加工商");
  await page.getByRole("button", { name: "返回旧列表" }).click();
  await expect(page.getByLabel("加工商列表")).toContainText("原加工商");
  await expect(page.getByLabel("加工商列表")).toContainText("新增加工商");
});
