// @playwright-project ui
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { loginAsTestUser } from "./helpers/functional-fixtures";

test.describe("time segment allocation UI", () => {
  test("扁平工作台默认挂载周尺度时间线且筛选保留视口", async ({
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

    await page.goto("/progress");
    await expect(page.getByRole("navigation", { name: "工作台视图" })).toHaveCount(0);
    await expect(page.getByText("当前没有有效参与的任务。", { exact: true })).toBeVisible();
    await expect(page.getByTestId("workbench-priority-content")).toBeVisible();
    await expect(page.getByLabel("选择日期")).toHaveCount(0);
    await expect(page.getByTestId("time-canvas-range-pan-bar")).toHaveCount(0);
    const canvasRoot = page.getByTestId("time-canvas-root");
    await expect(canvasRoot).toBeVisible();
    await expect(canvasRoot).toHaveAttribute("data-zoom", "WEEK");
    const canvasScroll = page.getByTestId("time-canvas-scroll");
    const bottomScrollbar = page.getByTestId("time-canvas-bottom-scrollbar");
    await expect(bottomScrollbar).toBeVisible();
    await expect.poll(() => canvasScroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const scrollbarGeometry = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>("[data-testid='time-canvas-scroll-shell']");
      const canvas = document.querySelector<HTMLElement>("[data-testid='time-canvas-scroll']");
      const scrollbar = document.querySelector<HTMLElement>("[data-testid='time-canvas-bottom-scrollbar']");
      if (!shell || !canvas || !scrollbar) return null;
      const shellBox = shell.getBoundingClientRect();
      const canvasBox = canvas.getBoundingClientRect();
      const scrollbarBox = scrollbar.getBoundingClientRect();
      return {
        canvasBottom: canvasBox.bottom,
        scrollbarTop: scrollbarBox.top,
        scrollbarBottom: scrollbarBox.bottom,
        shellBottom: shellBox.bottom,
      };
    });
    expect(scrollbarGeometry).not.toBeNull();
    expect(Math.abs(scrollbarGeometry!.shellBottom - scrollbarGeometry!.scrollbarBottom)).toBeLessThanOrEqual(1);
    expect(scrollbarGeometry!.scrollbarTop).toBeLessThan(scrollbarGeometry!.canvasBottom);
    expect(scrollbarGeometry!.scrollbarBottom).toBeGreaterThanOrEqual(scrollbarGeometry!.canvasBottom - 1);

    const mainScrollTarget = await canvasScroll.evaluate((element) => Math.floor((element.scrollWidth - element.clientWidth) / 2));
    await canvasScroll.evaluate((element, left) => { element.scrollLeft = left; }, mainScrollTarget);
    await expect.poll(() => bottomScrollbar.locator("[aria-label='时间轴横向滚动']").evaluate((element) => element.scrollLeft)).toBe(mainScrollTarget);
    const customScrollbar = bottomScrollbar.locator("[aria-label='时间轴横向滚动']");
    const customScrollTarget = await customScrollbar.evaluate((element) => Math.max(0, element.scrollWidth - element.clientWidth));
    await customScrollbar.evaluate((element, left) => { element.scrollLeft = left; }, customScrollTarget);
    await expect.poll(() => canvasScroll.evaluate((element) => element.scrollLeft)).toBe(customScrollTarget);
    for (const scale of ["周", "月", "季", "年"]) {
      await expect(page.getByRole("button", { name: scale, exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: "年", exact: true }).click();
    await expect(page).toHaveURL(/scale=year/);
    await expect(page.getByTestId("time-canvas-bottom-scrollbar")).toHaveCount(0);
    await expect.poll(() =>
      new URL(page.url()).searchParams.get("center"),
    ).not.toBeNull();
    const viewportUrl = new URL(page.url());
    const currentCenter = viewportUrl.searchParams.get("center");
    expect(currentCenter).toBeTruthy();
    await page.getByRole("link", { name: "显示全部", exact: true }).click();
    await expect(page).toHaveURL(/tasks=all/);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("center"))
      .toBe(currentCenter);
    const pagedUrl = new URL(page.url());
    expect(pagedUrl.searchParams.has("view")).toBe(false);
    expect(pagedUrl.searchParams.get("center")).toBe(currentCenter);
    expect(pagedUrl.searchParams.get("scale")).toBe("year");
    await expect(canvasRoot).toHaveAttribute("data-zoom", "YEAR");
    await page.getByRole("link", { name: "只看进行中", exact: true }).click();
    await expect(page).toHaveURL((url) => !url.searchParams.has("tasks") && !url.searchParams.has("view") && url.searchParams.get("center") === currentCenter && url.searchParams.get("scale") === "year");
    await page.reload();
    await expect(canvasRoot).toHaveAttribute("data-zoom", "YEAR");
    await expect(page.getByTestId("workbench-priority-content")).toBeVisible();
    await expect(page).toHaveURL((url) => url.pathname === "/progress" && !url.searchParams.has("view") && url.searchParams.get("center") === currentCenter && url.searchParams.get("scale") === "year");
    await expect(canvasRoot).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await page.goto(`/progress?focus=${randomUUID()}`);
    await expect(page).toHaveURL(/focusError=1/);
    await expect(page.getByText(
      "无法定位该时间对象，请确认链接仍然有效且你有权查看。",
    )).toBeVisible();

    const retiredPage = await page.goto("/progress/my-timeline");
    expect(retiredPage?.status()).toBe(404);
  });
});
