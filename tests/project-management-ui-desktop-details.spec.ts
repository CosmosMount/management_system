// @playwright-project ui
import { expect, test, type Dialog } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { createUiFixture } from "./helpers/project-management-ui-fixtures";
import { expectHealthyPage, expectNoHorizontalOverflow, loginAsTestUser } from "./helpers/functional-fixtures";

test("详情分区让节点优先可见并保留填写、URL和画布视口", async ({ context, page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await createUiFixture();
  const title = "整机联调与验收材料整理".repeat(12);
  await prisma.task.update({ where: { id: fixture.taskId }, data: { title, description: "完整背景说明".repeat(150) } });
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`/progress/tasks/${fixture.taskId}`);
  const unexpectedDocumentNavigations: string[] = [];
  const recordDocumentNavigation = (request: import("@playwright/test").Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      unexpectedDocumentNavigations.push(request.url());
    }
  };
  page.on("request", recordDocumentNavigation);
  const navigation = page.getByRole("navigation", { name: "任务详情分区" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByTestId("task-execution-view")).toBeVisible();
  await expect(page.getByTestId("time-canvas-scroll")).toHaveCount(0);
  const nodePanel = page.locator("#task-selected-node-detail");
  const nodeBox = await nodePanel.boundingBox();
  expect(nodeBox).not.toBeNull();
  if (testInfo.project.name === "desktop") {
    expect(nodeBox!.y).toBeLessThan(700);
    expect(nodeBox!.width).toBeGreaterThan(850);
    await page.screenshot({ path: testInfo.outputPath("task-execution-first-screen.png"), animations: "disabled" });
  }
  const evidence = page.getByRole("textbox", { name: "文本证据", exact: true });
  await evidence.fill("切换视图不应丢失的验收说明");
  await navigation.getByRole("link", { name: "风险与讨论" }).click();
  await page.getByLabel("发表评论").fill("切换分区后发布评论仍应留在讨论区");
  await page.getByRole("button", { name: "发布评论", exact: true }).click();
  await expect(page.getByText("切换分区后发布评论仍应留在讨论区", { exact: true })).toBeVisible();
  await expect(page.getByLabel("发表评论")).toHaveValue("");
  await expect(navigation.getByRole("link", { name: "风险与讨论" })).toHaveAttribute("aria-current", "page");
  expect(new URL(page.url()).searchParams.get("section")).toBe("collaboration");
  await page.getByLabel("发表评论").fill("暂未发布的讨论内容");
  await navigation.getByRole("link", { name: "活动记录" }).click();
  await expect(page.getByTestId("task-activity-view")).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("发表评论")).toHaveValue("暂未发布的讨论内容");
  await page.goBack();
  await expect(evidence).toHaveValue("切换视图不应丢失的验收说明");
  await navigation.getByRole("link", { name: "计划与投入" }).click();
  await expect(page.getByTestId("task-plan-view")).toBeVisible();
  await expect(page.getByTestId("time-canvas-scroll")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("center")).not.toBeNull();
  const center = new URL(page.url()).searchParams.get("center");
  await navigation.getByRole("link", { name: "节点执行" }).click();
  await expect(evidence).toHaveValue("切换视图不应丢失的验收说明");
  await navigation.getByRole("link", { name: "计划与投入" }).click();
  await expect(page.getByTestId("time-canvas-scroll")).toBeVisible();
  expect(unexpectedDocumentNavigations).toEqual([]);
  expect(new URL(page.url()).searchParams.get("center")).toBe(center);
  await page.getByRole("button", { name: "新增投入", exact: true }).click();
  const draft = page.getByRole("form", { name: "投入快速创建" });
  await draft.getByLabel("内容", { exact: true }).fill("切换分区保留的未创建投入");
  const draftStart = await draft.getByLabel("开始", { exact: true }).inputValue();
  await navigation.getByRole("link", { name: "节点执行" }).click();
  await expect(page.getByTestId("task-execution-view")).toBeVisible();
  await expect(evidence).toHaveValue("切换视图不应丢失的验收说明");
  const escapeDialogs: string[] = [];
  const onEscapeDialog = async (dialog: Dialog) => {
    escapeDialogs.push(dialog.message());
    await dialog.dismiss();
  };
  page.on("dialog", onEscapeDialog);
  await page.keyboard.press("Escape");
  page.off("dialog", onEscapeDialog);
  expect(escapeDialogs).toEqual([]);
  await navigation.getByRole("link", { name: "计划与投入" }).click();
  await expect(draft.getByLabel("内容", { exact: true })).toHaveValue("切换分区保留的未创建投入");
  await expect(draft.getByLabel("开始", { exact: true })).toHaveValue(draftStart);
  await draft.getByRole("button", { name: "取消", exact: true }).click();
  expect(unexpectedDocumentNavigations).toEqual([]);
  page.off("request", recordDocumentNavigation);
  await page.reload();
  await expect(page.getByTestId("task-plan-view")).toBeVisible();
  await page.goto(`/progress/tasks/${fixture.taskId}?section=collaboration#risks`);
  await expect(page.locator("#risks")).toBeVisible();
  await expect(navigation.getByRole("link", { name: "风险与讨论" })).toHaveAttribute("aria-current", "page");
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
