// @playwright-project ui
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { getManagementOverview } from "../lib/project-management/queries/management-overview-queries";
import { actor, createAccountPerson, createUiFixture } from "./helpers/project-management-ui-fixtures";
import { assertOfficialPlaywrightEnvironment } from "../scripts/playwright-runner";
import { loginAsTestUser, expectHealthyPage } from "./helpers/functional-fixtures";
import { createTask } from "./helpers/project-management-canvas-security-fixtures";

test("management overview counts all readable risks, paginates and preserves read-only access", async ({ context, page, baseURL }) => {
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
  await page.goto("/progress?view=management");
  await expect(page.getByRole("heading", { name: "管理概览", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `未解决风险记录 ${overview.riskCount}`, exact: true })).toBeVisible();
  await expect(page.getByTestId("management-overview-summary").getByRole("link")).toHaveCount(4);
  if (test.info().project.name === "desktop") await page.screenshot({ path: test.info().outputPath("management-overview-desktop.png"), animations: "disabled" });
  const countingNote = page.getByText("项目、任务与风险为当前可读、未删除对象的全量计数", { exact: false });
  await expect(countingNote).toBeHidden();
  await page.getByText("统计口径与查看说明", { exact: true }).click();
  await expect(countingNote).toBeVisible();
  await page.getByText("统计口径与查看说明", { exact: true }).click();
  await expect(page.getByTestId("time-canvas-root")).toHaveCount(0);
  await expect(page.getByText("不可展示的删除对象风险", { exact: true })).toHaveCount(0);
  const firstPageText = await page.locator("#overview-risks").innerText();
  await page.getByRole("link", { name: "下一页风险" }).click();
  await expect(page).toHaveURL(/riskCursor=/);
  const nextPageText = await page.locator("#overview-risks").innerText();
  expect(risks.filter((risk) => firstPageText.includes(risk.content) || nextPageText.includes(risk.content))).toHaveLength(15);
  await page.reload();
  await expect(page.locator("#overview-risks")).toHaveText(nextPageText, { useInnerText: true });
  await page.locator("#overview-risks").getByRole("link", { name: `项目：${project.name}`, exact: true }).first().click();
  await expect(page).toHaveURL((url) => url.pathname === `/progress/projects/${project.id}` && url.searchParams.get("section") === "collaboration" && url.hash === "#risks");
  await expect(page.locator("#risks")).toBeVisible();
  await expect(page.getByTestId("time-canvas-root")).toHaveCount(0);
  await page.goto(`/progress?view=management&riskCursor=${risks.find((risk) => nextPageText.includes(risk.content))!.id}`);
  await expect(page.locator("#overview-risks").getByText(taskRisk.content, { exact: true })).toBeVisible();
  await page.locator("#overview-risks").getByRole("link", { name: `任务：${taskFixture.taskTitle}`, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/progress/tasks/${taskFixture.taskId}` && url.searchParams.get("section") === "collaboration" && url.hash === "#risks");
  await expect(page.locator("#risks")).toBeVisible();
  await expect(page.getByTestId("time-canvas-root")).toHaveCount(0);
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
  await page.goto(`/progress?view=management&riskCursor=${overview.nextCursor}`);
  await page.getByRole("link", { name: "返回第一页" }).click();
  await expect(page).not.toHaveURL(/riskCursor=/);
  await page.goto("/progress?view=management&riskCursor=invalid");
  await expect(page.getByRole("status")).toContainText("风险列表已变化");
  await prisma.person.update({ where: { id: user.person.id }, data: { status: "INACTIVE" } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "管理概览", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /批准|审批通过|提交/ })).toHaveCount(0);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
  await context.clearCookies();
  await page.goto("/progress?view=management");
  await expect(page).toHaveURL(/\/login/);
});

test("management overview shows a safe retry when its initial query fails", async ({ context, page, baseURL }) => {
  assertOfficialPlaywrightEnvironment(process.env);
  const user = await createAccountPerson(`概览错误恢复 ${randomUUID()}`);
  await loginAsTestUser(context, baseURL, { openId: user.openId, name: user.person.displayName });
  await prisma.$executeRaw`ALTER TABLE "RiskRecord" RENAME TO "UiOverviewUnavailableRiskRecord"`;
  try {
    await page.goto("/progress?view=management");
    await expect(page.getByRole("alert")).toContainText("管理概览暂时无法加载");
    await expect(page.getByRole("link", { name: "重新加载管理概览", exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("UiOverviewUnavailableRiskRecord");
    await expect(page.locator("body")).not.toContainText("PrismaClientKnownRequestError");
    await expectHealthyPage(page);
  } finally {
    await prisma.$executeRaw`ALTER TABLE "UiOverviewUnavailableRiskRecord" RENAME TO "RiskRecord"`;
  }
  await page.getByRole("link", { name: "重新加载管理概览", exact: true }).click();
  await expect(page.getByTestId("management-overview-summary")).toBeVisible();
  await expect(page.getByText("管理概览暂时无法加载", { exact: true })).toHaveCount(0);
  await expectHealthyPage(page);
});

test("my work separates the personal schedule and preserves view history", async ({ context, page, baseURL }, testInfo) => {
  const user = await createAccountPerson(`工作台空态 ${randomUUID()}`);
  await loginAsTestUser(context, baseURL, { openId: user.openId, name: user.person.displayName });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto("/progress");
  await expect(page.getByText("当前没有有效参与的任务。", { exact: true })).toBeVisible();
  const content = page.getByTestId("workbench-priority-content");
  await expect(content.getByRole("heading", { name: "下一步", exact: true })).toBeVisible();
  await expect(content.getByRole("heading", { name: "参与任务", exact: true })).toBeVisible();
  await expect(page.getByTestId("time-canvas-root")).toHaveCount(0);
  if (testInfo.project.name === "desktop") {
    const nextStep = await content.getByRole("heading", { name: "下一步", exact: true }).boundingBox();
    const myTasks = await content.getByRole("heading", { name: "参与任务", exact: true }).boundingBox();
    expect(Math.abs(nextStep!.y - myTasks!.y)).toBeLessThan(10);
    expect(myTasks!.y).toBeLessThan(500);
  }
  const views = page.getByRole("navigation", { name: "工作台视图" });
  await views.getByRole("link", { name: "个人日程", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("view") === "schedule");
  await expect(views.getByRole("link", { name: "个人日程", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await expect(content).toHaveCount(0);
  await page.getByRole("link", { name: "显示全部", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("view") === "schedule" && url.searchParams.get("tasks") === "all");
  await page.reload();
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await expectHealthyPage(page);
  await views.getByRole("link", { name: "我的工作", exact: true }).click();
  await expect(content).toBeVisible();
  await expect(page.getByTestId("time-canvas-root")).toHaveCount(0);
  await views.getByRole("link", { name: "管理概览" }).click();
  await expect(page.getByRole("heading", { name: "管理概览", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
  await expect(page.getByTestId("time-canvas-root")).toHaveCount(0);
  await page.goto("/progress?view=management&focus=invalid");
  await expect(page).toHaveURL((url) => url.searchParams.get("view") === "schedule" && url.searchParams.get("focusError") === "1" && !url.searchParams.has("focus"));
  await expect(page.getByRole("status")).toContainText("无法定位该时间对象");
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await page.goto("/progress?view=management&focus=");
  await expect(views.getByRole("link", { name: "个人日程", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("participating work stays visible and focus links remain in schedule after closing", async ({ context, page, baseURL }) => {
  const fixture = await createUiFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.member.openId, name: fixture.member.person.displayName });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto("/progress");
  const tasks = page.getByRole("region", { name: "参与任务", exact: true });
  await expect(tasks.getByRole("link", { name: fixture.taskTitle, exact: true })).toBeVisible();
  if (test.info().project.name === "desktop") await page.screenshot({ path: test.info().outputPath("my-work-desktop.png"), animations: "disabled" });
  await expect(page.getByTestId("time-canvas-root")).toHaveCount(0);
  await expect(tasks.getByRole("link", { name: "查看全部参与任务", exact: true })).toHaveAttribute("href", "/progress/tasks?mine=1&status=ACTIVE");
  await page.getByRole("link", { name: "显示全部", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("tasks") === "all" && url.searchParams.get("view") !== "schedule");
  await expect(tasks.getByRole("link", { name: "查看全部参与任务", exact: true })).toHaveAttribute("href", "/progress/tasks?mine=1&status=");
  await tasks.getByRole("link", { name: fixture.taskTitle, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === `/progress/tasks/${fixture.taskId}`);
  await page.goto(`/progress?view=management&focus=${fixture.confirmableSegmentId}`);
  await expect(page).toHaveURL((url) => url.searchParams.get("view") === "schedule" && url.searchParams.get("focus") === fixture.confirmableSegmentId);
  const inspector = page.getByTestId("segment-inspector");
  await expect(inspector).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(inspector).toHaveCount(0);
  await expect(page).toHaveURL((url) => url.searchParams.get("view") === "schedule" && !url.searchParams.has("focus"));
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("dense workbench previews keep secondary items accessible without crowding the first screen", async ({ context, page, baseURL }) => {
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
  await expect(inbox.getByRole("link")).toHaveCount(4);
  await expect(inbox).toContainText("当前预览 8 / 9 项");
  const tasks = page.getByRole("region", { name: "参与任务", exact: true });
  await expect(tasks.locator("tbody tr")).toHaveCount(6);
  await expect(tasks.getByRole("link", { name: "查看全部参与任务（当前预览 6 项）", exact: true })).toBeVisible();
  await expectHealthyPage(page);
  const firstItem = inbox.getByTestId("action-inbox-item").first();
  await firstItem.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(firstItem.locator("details")).toHaveAttribute("open", "");
  await expect(firstItem.getByText("完成标准：查询测试通过", { exact: false })).toBeVisible();
  await inbox.getByText("展开其余 4 项待办", { exact: true }).click();
  await expect(inbox.getByRole("link")).toHaveCount(8);
  await expectHealthyPage(page);
  await tasks.getByRole("link", { name: "查看全部参与任务（当前预览 6 项）", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/progress/tasks" && url.searchParams.get("mine") === "1" && url.searchParams.get("status") === "ACTIVE");
  await expect(page.getByRole("region", { name: "任务列表", exact: true }).getByRole("article")).toHaveCount(9);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});
