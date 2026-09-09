// @playwright-project ui
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createDeadlineTask } from "./helpers/current-node-deadline-fixtures";
import { createAccountPerson, grantGlobalProjectAdministrator } from "./helpers/project-management-canvas-security-fixtures";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

test.beforeAll(async () => {
  const administrator = await createAccountPerson(`到期UI门禁 ${randomUUID()}`);
  await grantGlobalProjectAdministrator(administrator.account.id);
});

test("工作台风险排序先于六项截取，共享时钟跨界和聚焦更新", async ({ page, context, baseURL }) => {
  test.setTimeout(120_000);
  const owner = await createAccountPerson(`到期预览 ${randomUUID()}`);
  const nowMs = Date.now();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  for (let index = 0; index < 6; index += 1) {
    await createDeadlineTask(owner, { dueAt: new Date(nowMs + 5 * 86_400_000 + index * 60_000), title: `A正常任务${index} ${randomUUID()}` });
  }
  const overdue = await createDeadlineTask(owner, { dueAt: new Date(nowMs - 86_400_000), title: `Z逾期任务${"很长的任务名称".repeat(10)}${randomUUID()}` });
  const soon = await createDeadlineTask(owner, { dueAt: new Date(nowMs + 86_400_000), title: `Z临期任务 ${randomUUID()}` });
  await page.clock.install({ time: nowMs });
  await loginAsTestUser(context, baseURL, { openId: owner.openId, name: owner.person.displayName });
  await page.goto("/progress");
  const region = page.getByRole("region", { name: "参与任务", exact: true });
  await expect(region.locator("tbody tr")).toHaveCount(6);
  await expect(region.locator("tbody tr").first()).toHaveAttribute("data-testid", `participating-task-${overdue.taskId}`);
  const soonRow = region.getByTestId(`participating-task-${soon.taskId}`);
  await expect(soonRow.locator('[data-deadline-status="DUE_SOON"]')).toHaveText("即将到期");
  await expect(region.locator('tbody [data-deadline-status="NOT_DUE"]')).toHaveCount(4);
  await expect(region.locator('tbody [data-deadline-status="NOT_DUE"]').first()).toHaveText("距到期超过 3 天");
  await expectHealthyPage(page);
  await region.screenshot({ path: test.info().outputPath("deadline-workbench.png"), animations: "disabled" });
  await page.clock.fastForward(25 * 60 * 60_000);
  await expect(soonRow.locator('[data-deadline-status="OVERDUE"]')).toHaveText("已逾期");
  await page.clock.setSystemTime(new Date(nowMs));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(soonRow.locator('[data-deadline-status="DUE_SOON"]')).toBeVisible();
  await region.getByRole("link", { name: /查看全部参与任务/ }).click();
  await expect(page.getByTestId(`task-list-item-${overdue.taskId}`).getByText("已逾期", { exact: true })).toBeVisible();
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("任务、项目、待办、选择器与所有画布显示同一当前节点风险", async ({ page, context, baseURL }) => {
  test.setTimeout(180_000);
  const owner = await createAccountPerson(`到期跨页 ${randomUUID()}`);
  const project = await prisma.project.create({ data: { name: `到期展示项目 ${randomUUID()}`, description: "一致性回归", status: "ACTIVE", requesterAccountId: owner.account.id } });
  const fixture = await createDeadlineTask(owner, { dueAt: new Date(Date.now() - 86_400_000), projectId: project.id });
  const center = encodeURIComponent(fixture.dueAt.toISOString());
  await page.clock.install({ time: Date.now() });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await loginAsTestUser(context, baseURL, { openId: owner.openId, name: owner.person.displayName });
  for (const path of ["/progress/tasks?mine=1", `/progress/tasks/${fixture.taskId}`, `/progress/projects/${project.id}`, "/progress/approvals"]) {
    await page.goto(path);
    await expect(page.locator(`[data-deadline-node-id="${fixture.milestoneNodeId}"]`).first()).toContainText("已逾期");
    await expect(page.locator(`[data-deadline-node-id="${fixture.pendingNodeId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-deadline-node-id="${fixture.terminationNodeId}"]`)).toHaveCount(0);
    await expectHealthyPage(page);
  }
  const canvasPaths = [
    `/progress?view=schedule&center=${center}`,
    `/progress/kanban?people=${owner.person.id}&center=${center}`,
    `/progress/resources?all=0&tasks=${fixture.taskId}&center=${center}`,
    `/progress/tasks/${fixture.taskId}?section=plan&center=${center}`,
    `/progress/projects/${project.id}?section=plan&center=${center}`,
  ];
  for (const path of canvasPaths) {
    await page.goto(path);
    const canvas = page.getByTestId("time-canvas-root").first();
    await expect(canvas).toBeVisible();
    const marker = canvas.locator(`[data-anchor-id="${fixture.milestoneNodeId}"], [data-anchor-id="project-node:${fixture.milestoneNodeId}"]`);
    await expect(marker).toHaveAttribute("data-deadline-status", "OVERDUE");
    await expect(marker).toHaveAccessibleName(/已逾期/);
    await expect(marker).toHaveAttribute("data-anchor-editable", "false");
    await expect(canvas.locator('[data-deadline-status="OVERDUE"][data-anchor-id]')).toHaveCount(1);
    await expectHealthyPage(page);
    if (path.includes("/tasks/")) {
      await expect(page.getByRole("button", { name: /当前节点.*里程碑.*已逾期/ })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("deadline-task-canvas.png"), animations: "disabled" });
      await page.clock.setSystemTime(new Date(fixture.dueAt.getTime() - 60_000));
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByRole("button", { name: /当前节点.*里程碑.*即将到期/ })).toBeVisible();
      await page.clock.fastForward(120_000);
      await expect(page.getByRole("button", { name: /当前节点.*里程碑.*已逾期/ })).toBeVisible();
    }
  }
  await page.goto("/progress/tasks/new");
  await page.getByText("关联任务与项目（可选）", { exact: true }).click();
  await page.getByRole("combobox", { name: "关联任务", exact: true }).fill(fixture.title);
  const option = page.getByRole("option", { name: fixture.title, exact: true });
  await expect(option).toBeVisible();
  await expect(option).toHaveAccessibleDescription(/已逾期/);
  await page.clock.setSystemTime(new Date(fixture.dueAt.getTime() - 60_000));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(option).toHaveAccessibleDescription(/即将到期/);
  await expect(option.locator('[data-deadline-status="DUE_SOON"]')).toBeVisible();
  await option.click();
  await expect(page.getByRole("combobox", { name: "关联任务", exact: true })).toHaveValue(fixture.title);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("结束节点回退、任务终态与只读人员看板保持正确提示", async ({ page, context, baseURL }) => {
  test.setTimeout(120_000);
  const owner = await createAccountPerson(`结束到期UI ${randomUUID()}`);
  const viewer = await createAccountPerson(`只读查看者 ${randomUUID()}`);
  const fixture = await createDeadlineTask(owner, { dueAt: new Date(Date.now() - 27 * 86_400_000) });
  await prisma.$transaction([
    prisma.taskNode.update({ where: { id: fixture.milestoneNodeId }, data: { status: "COMPLETED" } }),
    prisma.taskNode.update({ where: { id: fixture.pendingNodeId }, data: { status: "COMPLETED" } }),
    prisma.task.update({ where: { id: fixture.taskId }, data: { activeMilestoneNodeId: null } }),
  ]);
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await loginAsTestUser(context, baseURL, { openId: viewer.openId, name: viewer.person.displayName });
  await page.goto(`/progress/kanban?people=${owner.person.id}`);
  const marker = page.locator(`[data-anchor-id="${fixture.terminationNodeId}"]`);
  await expect(marker).toHaveAttribute("data-deadline-status", "DUE_SOON");
  await expect(marker).toHaveAttribute("data-anchor-editable", "false");
  await expectHealthyPage(page);
  await prisma.task.update({ where: { id: fixture.taskId }, data: { status: "COMPLETED", endedAt: new Date() } });
  await page.goto(`/progress/tasks?mine=0&status=COMPLETED&q=${encodeURIComponent(fixture.title)}`);
  const row = page.getByTestId(`task-list-item-${fixture.taskId}`);
  await expect(row).toBeVisible();
  await expect(row.locator("[data-deadline-status]")).toHaveCount(0);
  await expect(row.getByText("已完成", { exact: true })).toBeVisible();
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});
