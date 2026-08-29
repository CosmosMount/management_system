// @playwright-project ui
import { expect, test } from "@playwright/test";
import {
  expectHealthyPage,
  formatPrismaError,
  loginAsNormalUser,
  loginAsOtherUser,
  prepareFunctionalFixtures,
  resolveNormalAuthMaterial,
  type FunctionalFixtureIds,
} from "./helpers/functional-fixtures";

test.describe.configure({ mode: "serial" });

let fixtures: FunctionalFixtureIds;
let normalAuth: Awaited<ReturnType<typeof resolveNormalAuthMaterial>>;

test.beforeAll(async () => {
  normalAuth = await resolveNormalAuthMaterial();
  try {
    fixtures = await prepareFunctionalFixtures(normalAuth);
  } catch (error) {
    throw new Error(`Playwright fixture 准备失败：${formatPrismaError(error)}`);
  }
});

test("上传文件路由要求登录且授权用户可读取文件", async ({
  page,
  context,
  baseURL,
}) => {
  await context.clearCookies();
  const anonymousResponse = await page.goto(fixtures.uploadPublicPath);
  expect(anonymousResponse?.status()).toBeLessThan(500);
  await expect(page).toHaveURL(/\/login\?callbackUrl=/);
  await expect(page.getByText("请使用飞书账号登录")).toBeVisible();

  await loginAsNormalUser(context, baseURL, normalAuth);
  const authorizedResponse = await page.goto(fixtures.uploadPublicPath);
  expect(authorizedResponse?.status()).toBe(200);
  expect(authorizedResponse?.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.getByText("playwright-owned-file")).toBeVisible();
});

test("上传文件路由对无关登录用户隐藏文件", async ({
  page,
  context,
  baseURL,
}) => {
  await loginAsOtherUser(context, baseURL);
  const unauthorizedResponse = await page.goto(fixtures.uploadPublicPath);

  expect(unauthorizedResponse?.status()).toBe(404);
  await expect(page.getByText("playwright-owned-file")).toHaveCount(0);
  await expectHealthyPage(page);
});
