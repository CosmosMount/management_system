// @playwright-project ui
import { expect, test } from "@playwright/test";
import { expectUnifiedWorkbench } from "./helpers/workbench-layout";
import { prisma } from "../lib/prisma";
import { createUiFixture } from "./helpers/project-management-ui-fixtures";
import { expectHealthyPage, expectNoHorizontalOverflow, loginAsTestUser } from "./helpers/functional-fixtures";

test("Task 同页工作台保留填写、旧链接和画布视口", async ({ context, page, baseURL }) => {
  test.setTimeout(90_000);
  const fixture = await createUiFixture();
  const title = "整机联调与验收材料整理".repeat(12);
  await prisma.task.update({ where: { id: fixture.taskId }, data: { title, description: "完整背景说明".repeat(150) } });
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`/progress/tasks/${fixture.taskId}?center=2026-08-01T10%3A00%3A00.000Z`);
  await expectUnifiedWorkbench(page, "task");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  const evidence = page.getByRole("textbox", { name: "文本证据", exact: true });
  await evidence.fill("同页联动不应丢失的验收说明");
  await page.getByLabel("发表评论").fill("同页发布评论不影响审批表单");
  await page.getByRole("button", { name: "发布评论", exact: true }).click();
  await expect(page.getByText("同页发布评论不影响审批表单", { exact: true })).toBeVisible();
  await expect(page.getByLabel("发表评论")).toHaveValue("");
  await expect(evidence).toHaveValue("同页联动不应丢失的验收说明");
  await page.getByLabel("发表评论").fill("暂未发布的讨论内容");
  await expect.poll(() => new URL(page.url()).searchParams.get("center")).not.toBeNull();
  const center = Date.parse(new URL(page.url()).searchParams.get("center")!);
  const canvas = page.getByTestId("time-canvas-root");
  const viewport = await canvas.evaluate((element) => {
    const start = Number(element.getAttribute("data-viewport-start-ms"));
    const end = Number(element.getAttribute("data-viewport-end-ms"));
    const scroller = element.querySelector<HTMLElement>('[data-testid="time-canvas-scroll"]')!;
    const header = scroller.querySelector<HTMLElement>('[data-testid^="timeline-row-"]')!.firstElementChild as HTMLElement;
    return { center: (start + end) / 2, msPerPixel: (end - start) / (scroller.clientWidth - header.clientWidth) };
  });
  expect(Number.isFinite(viewport.msPerPixel)).toBe(true);
  expect(viewport.msPerPixel).toBeGreaterThan(0);
  await page.getByRole("button", { name: "新增投入", exact: true }).click();
  const draft = page.getByRole("form", { name: "投入快速创建" });
  await draft.getByLabel("内容", { exact: true }).fill("同页联动保留的未创建投入");
  const draftStart = await draft.getByLabel("开始", { exact: true }).inputValue();
  await page.getByTestId("task-detail-main-column").scrollIntoViewIfNeeded();
  await expect(evidence).toHaveValue("同页联动不应丢失的验收说明");
  await page.getByTestId("task-detail-left-column").scrollIntoViewIfNeeded();
  await expect(page.getByLabel("发表评论")).toHaveValue("暂未发布的讨论内容");
  await expect(draft.getByLabel("内容", { exact: true })).toHaveValue("同页联动保留的未创建投入");
  await expect(draft.getByLabel("开始", { exact: true })).toHaveValue(draftStart);
  await expect(async () => {
    const currentCenter = await canvas.evaluate((element) =>
      (Number(element.getAttribute("data-viewport-start-ms")) + Number(element.getAttribute("data-viewport-end-ms"))) / 2);
    expect(Math.abs(currentCenter - viewport.center)).toBeLessThanOrEqual(viewport.msPerPixel);
    expect(Math.abs(Date.parse(new URL(page.url()).searchParams.get("center")!) - center)).toBeLessThanOrEqual(viewport.msPerPixel);
  }).toPass();
  await draft.getByRole("button", { name: "取消", exact: true }).click();
  await page.reload();
  await expectUnifiedWorkbench(page, "task");
  for (const section of ["execution", "plan", "collaboration", "activity", "unknown"]) {
    await page.goto(`/progress/tasks/${fixture.taskId}?section=${section}&focus=task-detail-start`);
    await expectUnifiedWorkbench(page, "task");
    await expect(page.getByTestId("task-plan-node-navigator").getByRole("button", { name: /开始节点/ })).toHaveAttribute("aria-pressed", "true");
  }
  await page.goto(`/progress/tasks/${fixture.taskId}?section=collaboration#risks`);
  await expect(page.locator("#risks")).toBeInViewport();
  await page.goto(`/progress/tasks/${fixture.taskId}#task-selected-node-detail`);
  await expect(page.locator("#task-selected-node-detail")).toBeInViewport();
  await page.goBack();
  await expect(page).toHaveURL(/#risks$/);
  await expectUnifiedWorkbench(page, "task");
  await page.goForward();
  await expect(page).toHaveURL(/#task-selected-node-detail$/);
  await expectUnifiedWorkbench(page, "task");
  await expectNoHorizontalOverflow(page);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("资源排期默认隐藏无效选择器且能按人员缩小范围", async ({ context, page, baseURL }, testInfo) => {
  const fixture = await createUiFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.goto("/progress/resources");
  await expect(page.getByRole("checkbox", { name: "显示全部资源" })).toBeChecked();
  await expect(page.getByRole("combobox", { name: "筛选人员" })).toHaveCount(0);
  await page.goto(`/progress/resources?all=0&people=${fixture.owner.person.id}`);
  await expect(page.getByTestId("time-canvas-scroll")).toBeVisible();
  if (testInfo.project.name === "desktop") {
    const canvasBox = await page.getByTestId("time-canvas-scroll").boundingBox();
    expect(canvasBox!.y).toBeLessThan(650);
    await page.screenshot({ path: testInfo.outputPath("resources-first-screen.png"), animations: "disabled" });
  }
  await expect(page.getByRole("combobox", { name: "筛选人员", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "清空选择" }).click();
  await page.getByRole("button", { name: "应用选择" }).click();
  await expect(page.getByText("当前未选择资源，应用后显示空画布。", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectHealthyPage(page);
});
