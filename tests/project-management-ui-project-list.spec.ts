// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { createDeadlineTask } from "./helpers/current-node-deadline-fixtures";
import { createAccountPerson, grantGlobalProjectAdministrator } from "./helpers/project-management-canvas-security-fixtures";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";
import { createProjectListFixture } from "./helpers/project-list-fixtures";

test.beforeAll(async () => {
  const administrator = await createAccountPerson(`项目列表UI门禁 ${randomUUID()}`);
  await grantGlobalProjectAdministrator(administrator.account.id);
});

test("项目行内任务紧急优先、最多两行，弹层与长名称提示支持键盘操作", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await createProjectListFixture();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.clock.install({ time: fixture.nowMs });
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.goto(`/progress/projects?q=${encodeURIComponent(fixture.prefix)}`);
  const row = page.getByTestId(`project-list-item-${fixture.project.id}`);
  await expect(row).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("project-list-long-content.png"), fullPage: true, animations: "disabled" });
  const overview = row.getByTestId("project-task-overview");
  const chips = overview.locator('[data-testid^="project-task-chip-"]');
  const overdueChip = row.getByTestId(`project-task-chip-${fixture.overdue.taskId}`);
  await expect(chips.first()).toHaveAttribute("data-testid", `project-task-chip-${fixture.overdue.taskId}`);
  await expect(overdueChip).toHaveAttribute("data-deadline-status", "OVERDUE");
  await expect(row.getByTestId(`project-task-chip-${fixture.soon.taskId}`)).toHaveAttribute("data-deadline-status", "DUE_SOON");
  await expect(row.getByTestId("project-task-summary")).toContainText("1 / 13");
  await expect(row.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "8");
  await expect(row.getByText("失败结束 1", { exact: true })).toBeVisible();
  await expect(row.getByText("已逾期 1", { exact: true })).toBeVisible();
  await expect(row.getByText("即将到期 1", { exact: true })).toBeVisible();
  await expect(row.locator("time")).toHaveAttribute("datetime", fixture.project.updatedAt.toISOString());
  const ownerTrigger = row.getByLabel(`项目负责人：${fixture.owner.person.displayName}、${fixture.secondOwner.person.displayName}`, { exact: true });
  await ownerTrigger.focus();
  await expect(page.getByRole("tooltip")).toContainText(fixture.secondOwner.person.displayName);
  await page.keyboard.press("Escape");
  await overdueChip.focus();
  await expect(page.getByRole("tooltip")).toContainText(fixture.overdue.title);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  if (testInfo.project.name === "desktop") {
    await overdueChip.hover();
    await expect(page.getByRole("tooltip")).toContainText(fixture.overdue.title);
    await page.keyboard.press("Escape");
    const rowBox = await row.boundingBox();
    expect(rowBox!.height).toBeLessThanOrEqual(160);
    await expect(page.getByText("汇总", { exact: true })).toBeVisible();
  }
  const overviewBox = await overview.boundingBox();
  expect(overviewBox!.height).toBeLessThanOrEqual(104);
  const visibleCount = await chips.count();
  expect(visibleCount).toBeLessThanOrEqual(7);
  const more = overview.getByRole("button", { name: /查看.*全部 9 个草稿或进行中的任务/ });
  await expect(more).toHaveText(`+${9 - visibleCount} 个任务`);
  const beforeHeight = (await row.boundingBox())!.height;
  await more.focus();
  await page.keyboard.press("Enter");
  const popup = page.getByRole("dialog");
  await expect(popup).toBeVisible();
  await expect(popup.locator('[data-testid^="project-task-chip-"]')).toHaveCount(9);
  await expect(popup.getByTestId(`project-task-chip-${fixture.draftId}`)).toContainText("草稿");
  await expect(popup.getByTestId(`project-task-chip-${fixture.missing.taskId}`)).toHaveAccessibleName(/暂无期限/);
  for (const task of [...fixture.hiddenTasks, fixture.deleted]) await expect(page.getByTestId(`project-task-chip-${task.taskId}`)).toHaveCount(0);
  expect((await row.boundingBox())!.height).toBe(beforeHeight);
  await expectHealthyPage(page);
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(more).toBeFocused();
  await page.clock.fastForward(120_000);
  await expect(row.getByTestId(`project-task-chip-${fixture.soon.taskId}`)).toHaveAttribute("data-deadline-status", "OVERDUE");
  await expect(row.getByText("已逾期 2", { exact: true })).toBeVisible();
  await page.clock.setSystemTime(new Date(fixture.nowMs));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(row.getByTestId(`project-task-chip-${fixture.soon.taskId}`)).toHaveAttribute("data-deadline-status", "DUE_SOON");
  await expectHealthyPage(page);
  await row.screenshot({ path: testInfo.outputPath("project-list-row.png"), animations: "disabled" });
  await overdueChip.click();
  await expect(page).toHaveURL(new RegExp(`/progress/tasks/${fixture.overdue.taskId}`));
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("六个项目的总览视觉验收保留独立项目行和紧凑任务摘要", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const owner = await createAccountPerson(`林示例 ${randomUUID()}`);
  const nowMs = Date.now();
  const examples = [
    { name: "机器人仿真", description: "用于机械臂控制的仿真测试", status: "ACTIVE", taskCount: 6 },
    { name: "VLA 训练", description: "基于 RL 的 VLA 训练实验", status: "ACTIVE", taskCount: 5 },
    { name: "数据采集平台", description: "多设备同步采集与数据质量监控", status: "ACTIVE", taskCount: 12 },
    { name: "机械臂控制", description: "机械臂运动规划与控制算法验证", status: "ACTIVE", taskCount: 6 },
    { name: "自动化测试", description: "", status: "DRAFT", taskCount: 4 },
    { name: "管理系统优化", description: "项目管理系统功能迭代", status: "COMPLETED", taskCount: 5 },
  ] as const;
  const taskNames = ["需求分析", "环境搭建", "算法开发", "仿真测试", "部署上线", "文档整理", "接口联调", "性能测试", "数据清洗", "模型评估", "结果分析", "成果交付"];
  for (const [projectIndex, example] of examples.entries()) {
    const project = await prisma.project.create({ data: {
      name: example.name, description: example.description, status: example.status, requesterAccountId: owner.account.id,
      updatedAt: new Date(nowMs - projectIndex * 86_400_000),
      members: { create: { personId: owner.person.id, role: "OWNER", createdByAccountId: owner.account.id } },
    } });
    for (let taskIndex = 0; taskIndex < example.taskCount; taskIndex += 1) {
      const task = await createDeadlineTask(owner, { projectId: project.id, title: taskNames[taskIndex], dueAt: new Date(nowMs + (taskIndex - 1) * 2 * 86_400_000) });
      const status = example.status === "COMPLETED" ? "COMPLETED" : example.status === "DRAFT" || taskIndex === 4 ? "DRAFT" : taskIndex === 5 ? "COMPLETED" : "ACTIVE";
      await prisma.task.update({ where: { id: task.taskId }, data: { status } });
    }
  }
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await loginAsTestUser(context, baseURL, { openId: owner.openId, name: owner.person.displayName });
  await page.goto("/progress/projects?status=&mine=1");
  const list = page.getByRole("region", { name: "项目列表", exact: true });
  await expect(list.getByRole("article")).toHaveCount(6);
  await expect.poll(() => list.getByTestId("task-chip-state").evaluateAll((elements) => elements.every((element) => element.scrollWidth <= element.clientWidth))).toBe(true);
  await expectHealthyPage(page);
  await page.screenshot({ path: testInfo.outputPath("project-list-six-projects.png"), fullPage: true, animations: "disabled" });
  if (testInfo.project.name === "desktop") {
    await list.evaluate((element) => { element.style.containerType = "normal"; });
    await expect(page.getByText("任务概览", { exact: true })).toBeVisible();
    for (const row of await list.getByRole("article").all()) expect((await row.boundingBox())!.height).toBeLessThanOrEqual(160);
    await page.setViewportSize({ width: 1744, height: 1094 });
    await expect.poll(() => list.getByTestId("project-task-overview").first().evaluate((element) => element.clientWidth)).toBeGreaterThan(400);
    await page.screenshot({ path: testInfo.outputPath("project-list-reference-width.png"), fullPage: true, animations: "disabled" });
    await list.screenshot({ path: testInfo.outputPath("project-list-table.png"), animations: "disabled" });
    await expectHealthyPage(page);
  }
  expect(errors).toEqual([]);
});

test("空概览保留整体完成进度，项目链接和既有状态筛选仍可用", async ({ page, context, baseURL }) => {
  test.setTimeout(120_000);
  const owner = await createAccountPerson(`项目列表空态 ${randomUUID()}`);
  const prefix = `空概览 ${randomUUID()}`;
  const project = await prisma.project.create({ data: { name: prefix, description: "", status: "COMPLETED", requesterAccountId: owner.account.id } });
  const completed = await createDeadlineTask(owner, { projectId: project.id, dueAt: new Date() });
  await prisma.task.update({ where: { id: completed.taskId }, data: { status: "COMPLETED" } });
  const cancelled = await createDeadlineTask(owner, { projectId: project.id, dueAt: new Date() });
  await prisma.task.update({ where: { id: cancelled.taskId }, data: { status: "CANCELLED" } });
  const empty = await prisma.project.create({ data: { name: `${prefix} 无任务`, description: "", status: "DRAFT", requesterAccountId: owner.account.id } });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await loginAsTestUser(context, baseURL, { openId: owner.openId, name: owner.person.displayName });
  await page.goto(`/progress/projects?status=&q=${encodeURIComponent(prefix)}`);
  const row = page.getByTestId(`project-list-item-${project.id}`);
  await expect(row.getByText("暂无草稿或进行中的任务", { exact: true })).toBeVisible();
  await expect(row.getByText("暂无项目简介", { exact: true })).toBeVisible();
  await expect(row.getByText("负责人未设置", { exact: true })).toBeVisible();
  await expect(row.getByTestId("project-task-summary")).toContainText("1 / 1");
  await expect(row.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  await expect(page.getByTestId(`project-list-item-${empty.id}`).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  await expectHealthyPage(page);
  await row.getByRole("link", { name: "打开", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/progress/projects/${project.id}`);
  await page.goBack();
  await row.getByRole("heading", { name: prefix, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/progress/projects/${project.id}`);
  await page.goto(`/progress/projects?status=ACTIVE&q=${encodeURIComponent(prefix)}`);
  await expect(page.getByText("没有符合条件的项目", { exact: true })).toBeVisible();
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});
