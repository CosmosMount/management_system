// @playwright-project ui
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

test.describe("entity picker controlled regressions", () => {
  test.beforeEach(async ({ context, page, baseURL }) => {
    const openId = `ou_entity_picker_${randomUUID()}`;
    const displayName = `实体选择器夹具 ${randomUUID()}`;
    await prisma.account.create({
      data: {
        identities: {
          create: {
            provider: "FEISHU",
            tenantId: "default",
            providerSubject: `open:${openId}`,
            openId,
          },
        },
        person: { create: { displayName, status: "ACTIVE" } },
      },
    });
    await loginAsTestUser(context, baseURL, { openId, name: displayName });
    await page.goto("/progress/entity-picker-fixtures");
    await expect(
      page.getByRole("heading", { name: "实体选择器受控验收夹具" }),
    ).toBeVisible();
  });

  test("ignores stale main and pagination responses and supports retry", async ({ page }) => {
    const input = page.getByLabel("竞态与重试选择器", { exact: true });
    const requestEvents = page.getByTestId("entity-picker-request-events");

    await input.click();
    await expect(requestEvents).toContainText("settled::first");
    await input.fill("slow");
    await expect(requestEvents).toContainText("started:slow:first");
    await input.fill("fast");
    await expect(page.getByRole("option", { name: "最新快响应" })).toBeVisible();
    await expect(requestEvents).toContainText("settled:slow:first");
    await expect(page.getByRole("option", { name: "过期慢响应" })).toHaveCount(0);

    await input.fill("failure");
    await expect(page.getByRole("alert")).toContainText("受控加载失败");
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.getByRole("option", { name: "重试恢复结果" })).toBeVisible();

    await input.fill("page-reset");
    await expect(page.getByRole("option", { name: "旧查询第一页" })).toBeVisible();
    await page.getByRole("button", { name: "加载更多" }).click();
    await input.fill("new-page");
    await expect(page.getByRole("option", { name: "新查询第一页" })).toBeVisible();
    await page.getByRole("button", { name: "加载更多" }).click();
    await expect(page.getByRole("option", { name: "新查询第二页" })).toBeVisible();
    await expect(requestEvents).toContainText(
      "settled:page-reset:stale-cursor",
    );
    await expect(page.getByRole("option", { name: "过期分页结果" })).toHaveCount(0);
    await expectHealthyPage(page);
  });

  test("merges concurrent selected-item resolutions without exposing IDs", async ({ page }) => {
    await page.getByRole("button", { name: "并发加入 B" }).click();
    await expect(page.getByText("并发恢复 B")).toBeVisible();
    await expect(page.getByText("并发恢复 A")).toBeVisible();
    await expect(page.getByText("resolve-a")).toHaveCount(0);
    await expect(page.getByText("resolve-b")).toHaveCount(0);
  });

  test("opens on keyboard focus and clears an abandoned query before reopening", async ({ page }) => {
    const single = page.getByLabel("键盘聚焦单选", { exact: true });
    await page.getByTestId("single-tab-start").focus();
    await page.keyboard.press("Tab");
    await expect(single).toBeFocused();
    await expect(single).toHaveAttribute("aria-expanded", "true");

    await single.fill("不透明 ID");
    await expect(page.getByRole("option", { name: "不透明 ID Task" })).toBeVisible();
    await single.press("Escape");
    await expect(single).toHaveAttribute("aria-expanded", "false");

    await page.getByTestId("single-tab-start").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("option", { name: "普通 Task" })).toBeVisible();

    const multi = page.getByLabel("键盘聚焦多选", { exact: true });
    await page.getByTestId("multi-tab-start").focus();
    await page.keyboard.press("Tab");
    await expect(multi).toBeFocused();
    await expect(multi).toHaveAttribute("aria-expanded", "true");
  });

  test("enforces the 50-item limit while keeping results browsable", async ({ page }) => {
    await expect(page.getByTestId("limit-count")).toHaveText("50");
    await expect(page.getByText(/已达到最多 50 项/)).toBeVisible();
    await page.getByLabel("50 项上限选择器", { exact: true }).click();
    const extra = page.getByRole("option", { name: "上限选项 51" });
    await expect(extra).toBeVisible();
    await expect(extra).toHaveAttribute("aria-disabled", "true");
    await extra.click({ force: true });
    await expect(page.getByTestId("limit-count")).toHaveText("50");
  });

  test("selects independent mode by keyboard and omits disabled hidden fields", async ({ page }) => {
    const input = page.getByLabel("独立投入选择器", { exact: true });
    await input.click();
    await input.press("ArrowUp");
    await input.press("Enter");
    await expect(page.getByTestId("selected-opaque-value")).toHaveText("独立投入");

    await page.getByRole("button", { name: "提交夹具表单" }).click();
    const submitted = page.getByTestId("submitted-form-data");
    await expect(submitted).toContainText('[["enabledTask",""]]');
    await expect(submitted).not.toContainText("disabledSingle");
    await expect(submitted).not.toContainText("disabledMulti");

    await input.click();
    await input.fill("不透明 ID");
    await page.getByRole("option", { name: "不透明 ID Task" }).click();
    await expect(page.getByTestId("selected-opaque-value")).toHaveText("不透明 ID 已保留");
    await page.getByRole("button", { name: "提交夹具表单" }).click();
    await expect(submitted).toContainText("__entity_picker_null_option__");
    await expectHealthyPage(page);
  });
});
