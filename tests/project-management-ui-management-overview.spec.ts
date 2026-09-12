// @playwright-project ui
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { getManagementOverview } from "../lib/project-management/queries/management-overview-queries";
import { actor, createAccountPerson, createUiFixture } from "./helpers/project-management-ui-fixtures";
import { loginAsTestUser, expectHealthyPage } from "./helpers/functional-fixtures";
import { createTask } from "./helpers/project-management-canvas-security-fixtures";

test("overview query counts readable risks while task plan links and workbench access remain safe", async ({ context, page, baseURL }) => {
  const user = await createAccountPerson(`概览读者 ${randomUUID()}`);
  const taskFixture = await createUiFixture();
  const before = await getManagementOverview(actor(user));
  const key = randomUUID();
  const project = await prisma.project.create({ data: { name: `概览长项目${key}${"很长的项目名称".repeat(10)}`, description: "概览测试", status: "COMPLETED", requesterAccountId: user.account.id } });
  const risks = await Promise.all(Array.from({ length: 15 }, (_, index) => prisma.riskRecord.create({ data: { projectId: project.id, content: `${key}风险${index}${"无空格详细风险".repeat(30)}`, createdByAccountId: user.account.id, createdByName: user.person.displayName } })));
  const preciseTime = new Date(Date.now() + 400 * 365 * 86400000);
  for (const [index, risk] of risks.entries()) {
    const microseconds = index < 10 ? 123999 : 123456;
    await prisma.$executeRaw`UPDATE "RiskRecord" SET "createdAt" = date_trunc('second', ${preciseTime}::timestamptz) + (${microseconds}::text || ' microseconds')::interval WHERE id = ${risk.id}`;
  }
  const taskRisk = await prisma.riskRecord.create({ data: { taskId: taskFixture.taskId, content: `${key}任务风险`, createdByAccountId: user.account.id, createdByName: user.person.displayName } });
  await prisma.$executeRaw`UPDATE "RiskRecord" SET "createdAt" = date_trunc('second', ${preciseTime}::timestamptz) + interval '123000 microseconds' WHERE id = ${taskRisk.id}`;
  await prisma.riskRecord.create({ data: { taskId: taskFixture.taskId, status: "RESOLVED", resolvedAt: new Date(), resolvedByAccountId: user.account.id, resolvedByName: user.person.displayName, resolveNote: "已处理", content: `${key}已解决`, createdByAccountId: user.account.id, createdByName: user.person.displayName } });
  await prisma.project.create({ data: { name: `${key}进行中`, description: "全量计数", status: "ACTIVE", requesterAccountId: user.account.id } });
  const deletedProject = await prisma.project.create({ data: { name: "已删除对象不应出现", description: "隐藏", status: "ACTIVE", deletedAt: new Date(), requesterAccountId: user.account.id } });
  await prisma.riskRecord.create({ data: { projectId: deletedProject.id, content: "不可展示的删除对象风险", createdByAccountId: user.account.id, createdByName: user.person.displayName } });
  const overview = await getManagementOverview(actor(user));
  expect(overview.riskCount).toBe(before.riskCount + 16);
  expect(overview.activeProjectCount).toBe(before.activeProjectCount + 1);
  expect(overview.activeTaskCount).toBe(before.activeTaskCount);
  await prisma.task.update({ where: { id: taskFixture.taskId }, data: { deletedAt: new Date() } });
  const withoutTask = await getManagementOverview(actor(user));
  expect(withoutTask.riskCount).toBe(before.riskCount + 15);
  expect(withoutTask.activeTaskCount).toBe(before.activeTaskCount - 1);
  await prisma.task.update({ where: { id: taskFixture.taskId }, data: { deletedAt: null } });
  expect(overview.risks).toHaveLength(12);
  expect(overview.risks.some((risk) => risk.project?.id === deletedProject.id)).toBe(false);
  await loginAsTestUser(context, baseURL, { openId: user.openId, name: user.person.displayName });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/progress/tasks/${taskFixture.taskId}?section=plan`);
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  let previousCenter = new URL(page.url()).searchParams.get("center");
  let stableSince = Date.now();
  await expect.poll(() => {
    const current = new URL(page.url()).searchParams.get("center");
    if (current !== previousCenter) {
      previousCenter = current;
      stableSince = Date.now();
    }
    return current !== null && Date.now() - stableSince >= 500;
  }).toBe(true);
  await page.getByTestId("time-canvas-scroll").evaluate((element) => {
    element.scrollLeft += element.scrollLeft > 120 ? -120 : 120;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(page).toHaveURL((url) => url.pathname === `/progress/tasks/${taskFixture.taskId}` && url.searchParams.get("section") === "plan" && url.searchParams.has("center") && url.searchParams.get("center") !== previousCenter);
  await page.goto("/progress");
  await prisma.person.update({ where: { id: user.person.id }, data: { status: "INACTIVE" } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /批准|审批通过|提交/ })).toHaveCount(0);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
  await page.goto("about:blank");
  await context.clearCookies();
  await page.goto("/progress?view=management");
  await expect(page).toHaveURL(/\/login/);
});

test("flat workbench places its timeline before task panels and canonicalizes retired views", async ({ context, page, baseURL }) => {
  const user = await createAccountPerson(`工作台空态 ${randomUUID()}`);
  await loginAsTestUser(context, baseURL, { openId: user.openId, name: user.person.displayName });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto("/progress");
  await expect(page.getByText("当前没有有效参与的任务。", { exact: true })).toBeVisible();
  const content = page.getByTestId("workbench-priority-content");
  await expect(content.getByRole("heading", { name: "我的待办", exact: true })).toBeVisible();
  await expect(content.getByRole("heading", { name: "参与任务", exact: true })).toBeVisible();
  await expect(content.getByRole("heading", { name: "下一步", exact: true })).toHaveCount(0);
  const metrics = page.getByLabel("工作指标");
  for (const label of ["进行中任务", "我的待办", "紧急待办", "未读通知"]) {
    await expect(metrics.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("region", { name: "我的待办", exact: true }).getByText("当前需要推进或审批的事项", { exact: true })).toBeVisible();
  await expectHealthyPage(page);
  await page.screenshot({ path: test.info().outputPath("my-work-empty.png"), animations: "disabled", fullPage: true });
  const timeline = page.getByRole("region", { name: "我的日程与投入", exact: true });
  await expect(timeline.getByTestId("time-canvas-root")).toBeVisible();
  const metricsBox = await metrics.boundingBox();
  const timelineBox = await timeline.boundingBox();
  const contentBox = await content.boundingBox();
  expect(timelineBox!.y).toBeGreaterThanOrEqual(metricsBox!.y + metricsBox!.height);
  expect(contentBox!.y).toBeGreaterThanOrEqual(timelineBox!.y + timelineBox!.height);
  const metricColumns = await metrics.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  expect(metricColumns).toBe((4));
  {
    const nextStep = await content.getByRole("heading", { name: "我的待办", exact: true }).boundingBox();
    const myTasks = await content.getByRole("heading", { name: "参与任务", exact: true }).boundingBox();
    expect(Math.abs(nextStep!.y - myTasks!.y)).toBeLessThan(10);
    expect(myTasks!.x).toBeGreaterThan(nextStep!.x);
    const inboxBox = await content.getByRole("region", { name: "我的待办", exact: true }).boundingBox();
    const tasksBox = await content.getByRole("region", { name: "参与任务", exact: true }).boundingBox();
    expect(tasksBox!.width / inboxBox!.width).toBeCloseTo(0.9, 1);
    const desktopViewport = page.viewportSize()!;
    await page.setViewportSize({ width: 768, height: 1000 });
    await expect.poll(() => metrics.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
    await expectHealthyPage(page);
    await page.setViewportSize(desktopViewport);
  }
  await expect(page.getByRole("navigation", { name: "工作台视图" })).toHaveCount(0);
  for (const retiredView of ["schedule", "management"]) {
    const center = "2026-08-15T00:00:00.000Z";
    await page.goto(`/progress?view=${retiredView}&riskCursor=invalid&tasks=all&center=${encodeURIComponent(center)}&scale=year`);
    await expect(page).toHaveURL((url) => url.pathname === "/progress" && !url.searchParams.has("view") && !url.searchParams.has("riskCursor") && url.searchParams.get("tasks") === "all" && url.searchParams.get("center") === center && url.searchParams.get("scale") === "year");
    await expect(page.getByRole("navigation", { name: "工作台视图" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "管理概览", exact: true })).toHaveCount(0);
    await expect(content).toBeVisible();
    await expect(page.getByTestId("time-canvas-root")).toHaveAttribute("data-zoom", "YEAR");
    await page.reload();
    await expect(content).toBeVisible();
    await expect(page.getByTestId("time-canvas-root")).toHaveAttribute("data-zoom", "YEAR");
    await expect(page).toHaveURL((url) => url.pathname === "/progress" && !url.searchParams.has("view") && !url.searchParams.has("riskCursor") && url.searchParams.get("tasks") === "all" && url.searchParams.get("center") === center && url.searchParams.get("scale") === "year");
    await expectHealthyPage(page);
  }
  await page.goto("/progress?view=management&focus=invalid");
  await expect(page).toHaveURL((url) => !url.searchParams.has("view") && url.searchParams.get("focusError") === "1" && !url.searchParams.has("focus"));
  await expect(page.getByRole("status")).toContainText("无法定位该时间对象");
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await page.goto("/progress?view=management&focus=");
  await expect(page).toHaveURL((url) => url.pathname === "/progress" && !url.searchParams.has("view") && !url.searchParams.has("focus"));
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("participating work stays visible and focus links return to the flat workbench after closing", async ({ context, page, baseURL }) => {
  const fixture = await createUiFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.member.openId, name: fixture.member.person.displayName });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto("/progress");
  const tasks = page.getByRole("region", { name: "参与任务", exact: true });
  const table = tasks.getByRole("table", { name: "参与任务列表", exact: true });
  await expect(table.getByRole("link", { name: fixture.taskTitle, exact: true })).toBeVisible();
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveText(["任务", "状态", "当前节点", "版本"]);
  await expect(table.locator("tbody tr").and(page.getByTestId(`participating-task-${fixture.taskId}`))).toBeVisible();
  const inbox = page.getByRole("region", { name: "我的待办", exact: true });
  await expect(inbox.getByRole("link", { name: "查看全部", exact: true })).toHaveAttribute("href", "/progress/approvals");
  await expectHealthyPage(page);
  await page.screenshot({ path: test.info().outputPath("my-work.png"), animations: "disabled", fullPage: true });
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await expect(tasks.getByRole("link", { name: /查看全部参与任务/ })).toHaveCount(0);
  await tasks.getByRole("link", { name: "显示全部", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("tasks") === "all" && !url.searchParams.has("view"));
  await expect(tasks.getByRole("link", { name: /查看全部参与任务/ })).toHaveCount(0);
  await expect(tasks.getByRole("link", { name: "只看进行中", exact: true })).toBeVisible();
  await table.getByRole("link", { name: fixture.taskTitle, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/progress/tasks/${fixture.taskId}`);
  await page.goto(`/progress?view=management&riskCursor=invalid&tasks=all&scale=quarter&focus=${fixture.confirmableSegmentId}`);
  await expect(page).toHaveURL((url) => url.pathname === "/progress" && !url.searchParams.has("view") && !url.searchParams.has("riskCursor") && url.searchParams.get("tasks") === "all" && url.searchParams.get("scale") === "quarter" && url.searchParams.get("focus") === fixture.confirmableSegmentId);
  const inspector = page.getByTestId("segment-inspector");
  await expect(inspector).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(inspector).toHaveCount(0);
  await expect(page).toHaveURL((url) => !url.searchParams.has("view") && !url.searchParams.has("focus"));
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await expect(page.getByTestId("workbench-priority-content")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "工作台视图" })).toHaveCount(0);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("dense workbench keeps all participating tasks in a table and retains compact inbox", async ({ context, page, baseURL }) => {
  test.setTimeout(120_000);
  const user = await createAccountPerson(`紧凑工作台 ${randomUUID()}`);
  for (let index = 0; index < 9; index += 1) {
    await createTask({
      ownerAccountId: user.account.id,
      title: `紧凑任务${index}${"很长的任务标题".repeat(24)}`,
      team: "英雄",
      techGroup: "电控",
      members: [{ personId: user.person.id, role: "OWNER" }],
    });
  }
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await loginAsTestUser(context, baseURL, { openId: user.openId, name: user.person.displayName });
  await page.goto("/progress");
  const inbox = page.getByTestId("action-inbox");
  await expect(inbox.getByTestId("action-inbox-item")).toHaveCount(8);
  await expect(inbox.getByRole("link")).toHaveCount(8);
  for (const link of await inbox.getByRole("link").all()) {
    await expect(link).toBeVisible();
  }
  await expect(inbox.locator("details, summary")).toHaveCount(0);
  await expect(inbox.getByText("展开其余 4 项待办", { exact: true })).toHaveCount(0);
  await expect(inbox).toContainText("当前预览 8 / 9 项");
  const tasks = page.getByRole("region", { name: "参与任务", exact: true });
  const table = tasks.getByRole("table", { name: "参与任务列表", exact: true });
  await expect(table.locator("tbody tr[data-testid^='participating-task-']")).toHaveCount(9);
  await expect(table.getByRole("columnheader")).toHaveText(["任务", "状态", "当前节点", "版本"]);
  await expect(table.locator("tbody tr td:last-child")).toHaveText(Array(9).fill("v1"));
  await expect(tasks.getByRole("link", { name: /查看全部参与任务/ })).toHaveCount(0);
  await expect(tasks.getByRole("link", { name: "显示全部", exact: true })).toBeVisible();
  await expect(tasks).not.toContainText("当前预览");
  const tableScroll = tasks.getByRole("region", { name: "参与任务表格滚动区域", exact: true });
  await expect(tableScroll).toHaveAttribute("tabindex", "0");
  await tableScroll.focus();
  await expect(tableScroll).toBeFocused();
  const tableLayout = await table.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(tableLayout.width).toBeGreaterThanOrEqual(42 * tableLayout.rootFontSize);
  await expect(tableScroll).toHaveCSS("overflow-x", "auto");
  await tableScroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(() => tableScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  const firstTaskLink = table.locator("tbody tr").first().getByRole("link");
  await expect(firstTaskLink).toContainText("很长的任务标题".repeat(24));
  await expect(firstTaskLink).toHaveCSS("white-space", "normal");
  await expect(firstTaskLink).not.toHaveCSS("text-overflow", "ellipsis");
  await expectHealthyPage(page);
  const taskHref = await firstTaskLink.getAttribute("href");
  expect(taskHref).toMatch(/^\/progress\/tasks\/[^/]+$/);
  await firstTaskLink.click();
  await expect(page).toHaveURL((url) => url.pathname === taskHref);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});
