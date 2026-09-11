import { expect, type Page } from "@playwright/test";

export async function expectUnifiedWorkbench(page: Page, kind: "task" | "project") {
  const timeline = page.getByTestId(`${kind}-plan-view`);
  const main = page.getByTestId(`${kind}-detail-main-column`);
  const left = page.getByTestId(`${kind}-detail-left-column`);
  const right = page.getByTestId(`${kind}-detail-right-column`);
  await expect(page.getByRole("navigation", { name: kind === "task" ? "任务详情分区" : "项目详情视图" })).toHaveCount(0);
  for (const region of [timeline, main, left, right]) await expect(region).toBeVisible();
  await expect(page.getByRole("heading", { name: "近期动态", exact: true })).toHaveCount(1);
  await expect(async () => {
    const [timelineBox, mainBox, leftBox, rightBox] = await page.evaluate((prefix) =>
      [`${prefix}-plan-view`, `${prefix}-detail-main-column`, `${prefix}-detail-left-column`, `${prefix}-detail-right-column`].map((testId) => {
        const element = document.querySelector(`[data-testid="${testId}"]`);
        if (!element) throw new Error("无法读取工作台布局");
        return element.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number };
      }), kind);
    expect(mainBox.y).toBeGreaterThanOrEqual(timelineBox.y + timelineBox.height);
    if ((page.viewportSize()?.width ?? 0) >= 1280) {
      expect(leftBox.x + leftBox.width).toBeLessThan(mainBox.x);
      expect(mainBox.x + mainBox.width).toBeLessThan(rightBox.x);
      expect(Math.abs(leftBox.y - mainBox.y)).toBeLessThan(2);
      expect(Math.abs(rightBox.y - mainBox.y)).toBeLessThan(2);
    } else {
      expect(leftBox.y).toBeGreaterThanOrEqual(mainBox.y + mainBox.height);
      expect(rightBox.y).toBeGreaterThanOrEqual(leftBox.y + leftBox.height);
    }
  }).toPass();
}
