// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { rejectRevision } from "../lib/project-management/application/lifecycle-service";
import { assertOfficialPlaywrightEnvironment } from "../scripts/playwright-runner";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";
import { openTaskComposerDisclosure } from "./helpers/project-management-plan-mutation-fixtures";
import { actor, createAccountPerson, createDraftWorkbenchFixture, createUiFixture, grantRole } from "./helpers/project-management-ui-fixtures";

test.beforeEach(async ({ page }) => {

  assertOfficialPlaywrightEnvironment(process.env);
  expect(page.viewportSize()).toEqual({ width: 1440, height: 1000 });
});

test("desktop task sections reveal invalid fields and preserve a recovered zero-milestone draft", async ({ context, page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  const creator = await createAccountPerson(`Stage4 创建 ${randomUUID()}`);
  await grantRole(creator.account.id, "PROJECT_ADMINISTRATOR");
  await loginAsTestUser(context, baseURL, { openId: creator.openId, name: creator.person.displayName });
  await page.goto("/progress/tasks/new");
  const navigation = page.getByRole("navigation", { name: "任务表单分区" });
  await expect(navigation).toBeVisible();
  await expect(page.getByLabel("描述", { exact: true })).toBeHidden();
  await expect(page.getByLabel("关联任务", { exact: true })).toBeHidden();
  await expect(page.getByTestId("time-canvas-root")).toBeHidden();
  await desktopEvidence(page, errors, testInfo, "task-create-first");

  await page.locator("#task-composer-basics > summary").click();
  await expect(page.getByRole("textbox", { name: "任务名称*", exact: true, includeHidden: true })).toBeHidden();
  await page.getByRole("button", { name: "创建任务草稿", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "任务名称*", exact: true, includeHidden: true })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "任务名称*", exact: true, includeHidden: true })).toHaveAttribute("aria-invalid", "true");
  const title = `Stage4 零里程碑 ${"长任务名称".repeat(12)} ${randomUUID()}`;
  const description = "折叠资料与分区导航不得丢失的本地内容";
  await page.getByRole("textbox", { name: "任务名称*", exact: true, includeHidden: true }).fill(title);
  await openTaskComposerDisclosure(page, "补充说明与优先级");
  await page.getByLabel("描述", { exact: true }).fill(description);
  await page.getByLabel("优先级", { exact: true }).selectOption("HIGH");
  await page.locator("summary").filter({ hasText: "补充说明与优先级" }).click();
  await navigation.getByRole("button", { name: "2. 计划节点", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const nodes = page.getByTestId("task-plan-node-navigator");
  await nodes.getByRole("button", { name: /开始节点/ }).click();
  await page.getByLabel("计划开始时间").fill("2026-09-09T09:00");
  await nodes.getByRole("button", { name: /Terminal/ }).click();
  await page.getByLabel("计划结束时间").fill("2026-09-11T18:00");
  await page.getByLabel("结束条件").fill("完成复核与交接");
  await expect(page.getByTestId("task-composer-milestone-count")).toHaveText("0/200");
  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("task-draft:"));
    const raw = key ? localStorage.getItem(key) : null;
    return raw ? (JSON.parse(raw) as { task?: { termination?: { plannedOutcomeCriteria?: string } } }).task?.termination?.plannedOutcomeCriteria : null;
  })).toBe("完成复核与交接");
  await page.reload();
  await page.getByRole("button", { name: "恢复草稿", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "任务名称*", exact: true, includeHidden: true })).toHaveValue(title);
  await expect(page.getByLabel("描述", { exact: true })).toHaveValue(description);
  await expect(page.getByLabel("描述", { exact: true })).toBeHidden();
  await navigation.getByRole("button", { name: "3. 检查保存", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#task-composer-review")).toBeFocused();
  await expect(page.locator("#task-composer-review")).toContainText("0 个里程碑");
  await desktopEvidence(page, errors, testInfo, "task-review-zero-milestone");
  await page.getByRole("button", { name: "确认创建草稿", exact: true }).click();
  await expect(page).toHaveURL(/\/progress\/tasks\/(?!new(?:\?|$))[^/?]+/);
  const saved = await prisma.task.findFirstOrThrow({
    where: { title },
    include: { currentPlanVersion: { include: { nodes: { include: { node: { include: { termination: true } } } } } } },
  });
  expect(saved).toMatchObject({ status: "DRAFT", description, priority: "HIGH" });
  expect(saved.currentPlanVersion.nodes.filter((entry) => entry.node.type === "MILESTONE")).toHaveLength(0);
  expect(saved.currentPlanVersion.nodes.find((entry) => entry.node.type === "TERMINATION")?.node.termination?.name).toBe("Terminal");
  expect(await prisma.task.count({ where: { title } })).toBe(1);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});

test("desktop draft edit retains advanced fields and refuses a stale save", async ({ context, page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  const fixture = await createDraftWorkbenchFixture();
  await grantRole(fixture.admin.account.id, "PROJECT_ADMINISTRATOR");
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.goto(`/progress/tasks/${fixture.taskId}/edit`);
  await expect(page.getByTestId("task-composer")).toHaveAttribute("data-composer-mode", "EDIT_DRAFT");
  await expect(page.getByRole("button", { name: "确认保存任务", exact: true })).toBeDisabled();
  await openTaskComposerDisclosure(page, "补充说明与优先级");
  const description = `Stage4 已展开填写 ${randomUUID()}`;
  await page.getByLabel("描述", { exact: true }).fill(description);
  await page.locator("summary").filter({ hasText: "补充说明与优先级" }).click();
  await openTaskComposerDisclosure(page, "时间画布与批量调整（高级）");
  await expect(page.getByTestId("time-canvas-root")).toBeVisible();
  await page.getByTestId("task-composer-advanced-plan").locator("summary").click();
  const concurrentTitle = `Stage4 服务端并发更新 ${randomUUID()}`;
  await prisma.task.update({ where: { id: fixture.taskId }, data: { title: concurrentTitle, lockVersion: { increment: 1 } } });
  await page.getByRole("navigation", { name: "任务表单分区" }).getByRole("button", { name: "3. 检查保存", exact: true }).click();
  await page.getByRole("button", { name: "确认保存任务", exact: true }).click();
  await expect(page.getByText("任务已在服务端更新，当前本地修改不会覆盖最新版本。请先导出，或放弃并加载最新版本。")).toBeVisible();
  await expect(page.getByLabel("描述", { exact: true })).toHaveValue(description);
  expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId }, select: { title: true, description: true } })).toEqual({ title: concurrentTitle, description: "S6 Draft 工作台测试" });
  await desktopEvidence(page, errors, testInfo, "draft-stale-save");
});

test("desktop revision creation and resubmission retain read-only baselines and approval semantics", async ({ context, page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const errors = collectPageErrors(page);
  const fixture = await createUiFixture();
  const baseline = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId }, select: { currentPlanVersionId: true } });
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.goto(`/progress/tasks/${fixture.taskId}/revisions/new`);
  await expect(page.getByRole("textbox", { name: "任务名称*", exact: true, includeHidden: true })).toBeHidden();
  await page.getByRole("navigation", { name: "任务表单分区" }).getByRole("button", { name: "1. 基本资料", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "任务名称*", exact: true, includeHidden: true })).toBeDisabled();
  await page.locator("#task-composer-basics > summary").click();
  await page.getByTestId("task-plan-node-navigator").getByRole("button", { name: /开始节点/ }).click();
  await expect(page.getByLabel("计划开始时间")).toHaveAttribute("readonly", "");
  await page.getByRole("button", { name: "确认创建并送审", exact: true }).click();
  await expect(page.getByLabel("计划修订名称")).toBeFocused();
  const reason = `Stage4 候选计划 ${randomUUID()}`;
  await page.getByLabel("计划修订名称").fill(reason);
  await page.getByLabel("计划修订详细内容").fill("明确后续里程碑验收材料，不覆盖已承接节点");
  await page.getByLabel("计划修订时间").fill("2026-08-03T12:00");
  await desktopEvidence(page, errors, testInfo, "revision-form");
  await page.getByRole("button", { name: "确认创建并送审", exact: true }).click();
  await expect.poll(() => prisma.revisionNode.count({ where: { node: { taskId: fixture.taskId }, status: "PENDING_APPROVAL" } })).toBe(1);
  await expect(page).not.toHaveURL(/\/revisions\/new/);
  const revision = await prisma.revisionNode.findFirstOrThrow({ where: { node: { taskId: fixture.taskId }, status: "PENDING_APPROVAL" } });
  expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId }, select: { currentPlanVersionId: true } })).toEqual(baseline);
  await rejectRevision(actor(fixture.admin), { revisionNodeId: revision.id, comment: "请补充候选计划说明" });
  await page.goto(`/progress/tasks/${fixture.taskId}/revisions/${revision.id}/edit`);
  await expect(page.getByTestId("task-composer")).toHaveAttribute("data-composer-mode", "RESUBMIT_REVISION");
  await expect(page.getByRole("textbox", { name: "任务名称*", exact: true, includeHidden: true })).toBeHidden();
  await page.getByLabel("计划修订详细内容").fill("已补充验收材料与负责人复核步骤");
  await page.getByRole("navigation", { name: "任务表单分区" }).getByRole("button", { name: "3. 检查送审", exact: true }).click();
  await page.getByRole("button", { name: "确认修改并重新送审", exact: true }).click();
  await expect.poll(() => prisma.revisionNode.findUnique({ where: { id: revision.id }, select: { status: true, reviewRound: true } })).toEqual({ status: "PENDING_APPROVAL", reviewRound: 2 });
  expect(await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId }, select: { currentPlanVersionId: true } })).toEqual(baseline);
  expect(errors).toEqual([]);
});

test("desktop project optional upload errors reopen their section and establishment remains pending", async ({ context, page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const errors = collectPageErrors(page);
  const fixture = await createUiFixture();
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: fixture.owner.person.displayName });
  await page.goto("/progress/projects/new");
  await expect(page.getByRole("navigation", { name: "项目表单分区" })).toBeVisible();
  await expect(page.getByLabel("上传头像", { exact: true })).toBeHidden();
  await expect(page.getByRole("combobox", { name: "搜索可加入的任务" })).toBeHidden();
  await desktopEvidence(page, errors, testInfo, "project-create-first");
  await page.getByRole("button", { name: "提交立项", exact: true }).click();
  await expect(page.getByLabel("项目名称")).toBeFocused();
  const name = `Stage4 项目渐进披露 ${randomUUID()}`;
  await page.getByLabel("项目名称").fill(name);
  await page.getByLabel("项目内容").fill("基础资料与项目负责人先填写，可选头像和关联任务按需展开。");
  await page.getByLabel("搜索负责人", { exact: true }).fill(fixture.owner.person.displayName);
  await page.getByRole("option", { name: fixture.owner.person.displayName, exact: true }).click();
  const avatarOptions = page.getByTestId("project-form-avatar-options");
  await avatarOptions.locator("summary").click();
  await page.getByLabel("上传头像", { exact: true }).setInputFiles({ name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("not a valid image") });
  await avatarOptions.locator("summary").click();
  await page.getByRole("button", { name: "提交立项", exact: true }).click();
  await expect(avatarOptions).toHaveAttribute("open", "");
  await expect(page.getByLabel("上传头像", { exact: true })).toBeFocused();
  await expect(page.locator("#project-avatar-error")).toBeVisible();
  expect(await prisma.project.count({ where: { name } })).toBe(0);
  await desktopEvidence(page, errors, testInfo, "project-avatar-error-revealed");
  await page.getByLabel("上传头像", { exact: true }).setInputFiles([]);
  await page.getByRole("button", { name: "提交立项", exact: true }).click();
  await expect.poll(() => prisma.project.count({ where: { name, status: "PENDING_APPROVAL" } })).toBe(1);
  await expect(page).not.toHaveURL(/\/projects\/new/);
  await page.goto("/progress/approvals");
  await expect(page.getByRole("region", { name: "待处理事项", exact: true })).toBeVisible();
  const help = page.locator("summary").filter({ hasText: "处理范围与顺序" });
  await expect(help.locator("..")).not.toHaveAttribute("open", "");
  await help.click();
  await expect(help.locator("..")).toContainText("计划修订");
  await desktopEvidence(page, errors, testInfo, "approvals-help");
});

function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function desktopEvidence(page: Page, errors: string[], testInfo: TestInfo, name: string) {
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), animations: "disabled" });
}
