import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { loginAsTestUser } from "./helpers/functional-fixtures";

test.describe("time segment allocation UI", () => {
  test("我的时间使用自适应尺度和独立底部滚动条", async ({
    context,
    page,
    baseURL,
  }) => {
    const openId = `ou_pm_timeline_${randomUUID()}`;
    const name = `时间线验收用户 ${randomUUID()}`;
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
        person: {
          create: { displayName: name, status: "ACTIVE" },
        },
      },
    });
    await loginAsTestUser(context, baseURL, { openId, name });

    await page.goto("/progress/my-timeline");
    await expect(page.getByText("当前没有有效参与的 Task。", { exact: true })).toBeVisible();
    await expect(page.getByLabel("选择日期")).toHaveCount(0);
    await expect(page.getByTestId("time-canvas-range-pan-bar")).toHaveCount(0);
    await expect(page.getByTestId("time-canvas-root")).toBeVisible();
    await expect(page.getByTestId("time-canvas-bottom-scrollbar")).toBeVisible();
    for (const scale of ["周", "月", "季", "年"]) {
      await expect(page.getByRole("button", { name: scale, exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "年", exact: true }).click();
    await expect(page).toHaveURL(/scale=year/);
    await expect(page.getByTestId("time-canvas-bottom-scrollbar")).toHaveCount(0);
    const viewportUrl = new URL(page.url());
    const currentCenter = viewportUrl.searchParams.get("center");
    expect(currentCenter).toBeTruthy();
    await page.getByRole("link", { name: "显示全部", exact: true }).click();
    await expect(page).toHaveURL(/tasks=all/);
    const pagedUrl = new URL(page.url());
    expect(pagedUrl.searchParams.get("center")).toBe(currentCenter);
    expect(pagedUrl.searchParams.get("scale")).toBe("year");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await page.goto(`/progress/my-timeline?focus=${randomUUID()}`);
    await expect(page).toHaveURL(/focusError=1/);
    await expect(page.getByText(
      "无法定位该时间对象，请确认链接仍然有效且你有权查看。",
    )).toBeVisible();
  });
});
