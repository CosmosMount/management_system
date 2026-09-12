// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectUnifiedWorkbench } from "./helpers/workbench-layout";
import { prisma } from "../lib/prisma";
import { createRisk } from "../lib/project-management/application/collaboration-service";
import { createProject, reviewProjectEstablishment } from "../lib/project-management/application/project-service";
import { actor, createUiFixture } from "./helpers/project-management-ui-fixtures";
import { expectHealthyPage, expectNoHorizontalOverflow, loginAsTestUser } from "./helpers/functional-fixtures";

test("详情头部默认展开完整资料并保留桌面操作区", async ({ context, page, baseURL }, testInfo) => {
  const fixture = await createUiFixture();
  const project = await createProject(actor(fixture.owner), {
    name: "大符",
    description: "大符",
    avatarPath: null,
    members: [{ personId: fixture.owner.person.id, role: "OWNER" }],
    requestedTaskIds: [],
    idempotencyKey: randomUUID(),
  });
  const request = await prisma.projectEstablishmentRequest.findFirstOrThrow({ where: { projectId: project.projectId, status: "PENDING" } });
  await reviewProjectEstablishment(actor(fixture.admin), {
    projectId: project.projectId, requestId: request.id, expectedLockVersion: project.lockVersion,
    decision: "APPROVE", comment: "同意立项",
  });
  await prisma.task.update({ where: { id: fixture.taskId }, data: { title: "缓启动", description: "缓启动", projectId: project.projectId } });
  for (const [person, name] of [[fixture.owner.person, "项目负责人"], [fixture.member.person, "参与人员甲"], [fixture.reviewer.person, "参与人员乙"], [fixture.inactiveHistory.person, "历史参与人"]] as const) {
    await prisma.person.update({ where: { id: person.id }, data: { displayName: name } });
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loginAsTestUser(context, baseURL, { openId: fixture.owner.openId, name: "项目负责人" });
  for (const [kind, id, title] of [["project", project.projectId, "大符"], ["task", fixture.taskId, "缓启动"]] as const) {
    await page.goto(`/progress/${kind}s/${id}`);
    const overview = page.getByTestId(`${kind}-overview`);
    await expect(overview.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(overview.locator("summary").filter({ hasText: /项目说明与成员|任务资料与成员/ })).toHaveCount(0);
    await expect(overview.getByText("参与人员", { exact: true })).toBeVisible();
    await expect(overview.getByRole("button", { name: "复制链接", exact: true })).toBeVisible();
    await expect(page.getByTestId("project-management-command-bar")).toContainText(kind === "project" ? "查看 Project 基本信息" : "Task 执行工作台");
    await expect(overview.locator("p").filter({ hasText: new RegExp(`^${title}$`) })).toBeVisible();
    if (testInfo.project.name === "desktop") {
      const boxes = await overview.locator("dl > div").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
      const columns = kind === "project" ? 3 : 4;
      expect(boxes).toHaveLength(kind === "project" ? 3 : 8);
      for (let index = 0; index < boxes.length; index += 1) {
        expect(Math.abs(boxes[index].y - boxes[Math.floor(index / columns) * columns].y)).toBeLessThan(2);
        if (index % columns > 0) expect(boxes[index].x).toBeGreaterThan(boxes[index - 1].x);
        if (index >= columns) expect(boxes[index].y).toBeGreaterThan(boxes[index - columns].y);
      }
      const cardBox = await overview.boundingBox();
      const actionsBox = await page.getByTestId(`${kind}-overview-actions`).boundingBox();
      expect(cardBox).not.toBeNull();
      expect(actionsBox).not.toBeNull();
      expect(actionsBox!.x).toBeGreaterThan(cardBox!.x + cardBox!.width / 2);
      expect(actionsBox!.y - cardBox!.y).toBeLessThan(30);
    }
    await expectHealthyPage(page);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`${kind}-head-desktop.png`), animations: "disabled" });
    if (kind === "task") {
      await expect(overview.locator("dl > div")).toHaveCount(8);
      await expect(overview.getByText("当前节点", { exact: true })).toBeVisible();
      await expect(overview.getByRole("link", { name: "发起计划修订", exact: true })).toBeVisible();
    }
  }
  await prisma.task.update({ where: { id: fixture.taskId }, data: { title: "长任务名称".repeat(40), description: "完整说明".repeat(100) } });
  await page.reload();
  await expect(page.getByTestId("task-overview").getByRole("heading")).toHaveText("长任务名称".repeat(40));
  await expectNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test("Project unified workbench preserves risk and comment drafts during timeline interaction", async ({ context, page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await createUiFixture();
  const owner = actor(fixture.owner);
  const administrator = {
    ...actor(fixture.admin),
    systemRoles: [{ role: "PROJECT_ADMINISTRATOR" as const, team: "", techGroup: "" }],
  };
  const projectName = `项目同页草稿保留 ${randomUUID()}`;
  const project = await createProject(owner, {
    name: projectName,
    description: "项目说明保持折叠，不挤占首屏任务和风险摘要。\n".repeat(20),
    avatarPath: null,
    members: [{ personId: owner.personId, role: "OWNER" }],
    requestedTaskIds: [],
    idempotencyKey: randomUUID(),
  });
  const request = await prisma.projectEstablishmentRequest.findFirstOrThrow({
    where: { projectId: project.projectId, status: "PENDING" },
  });
  await reviewProjectEstablishment(administrator, {
    projectId: project.projectId,
    requestId: request.id,
    expectedLockVersion: project.lockVersion,
    decision: "APPROVE",
    comment: "同意立项",
  });
  await prisma.task.update({
    where: { id: fixture.taskId },
    data: { projectId: project.projectId, title: "整机联调与验收证据整理" },
  });
  await createRisk(owner, {
    targetType: "PROJECT",
    targetId: project.projectId,
    content: "已有风险：需要确认联调场地时间",
  });
  const riskCount = await prisma.riskRecord.count({ where: { projectId: project.projectId } });
  const commentCount = await prisma.comment.count({ where: { projectId: project.projectId } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await loginAsTestUser(context, baseURL, { openId: owner.openId, name: "项目负责人" });
  await page.goto(`/progress/projects/${project.projectId}`);

  await expectUnifiedWorkbench(page, "project");
  await expect(page.getByRole("heading", { level: 1, name: "Project 详情" })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 2, name: projectName })).toHaveCount(1);
  await expect(page.getByTestId("time-canvas-root")).toHaveCount(1);
  await expect(page.locator("#risks")).toContainText("已有风险：需要确认联调场地时间");
  await page.screenshot({ path: testInfo.outputPath("project-unified-workbench.png"), animations: "disabled" });

  const riskInput = page.getByLabel("风险内容", { exact: true });
  const commentInput = page.getByLabel("发表评论", { exact: true });
  const riskDraft = "尚未提交的风险：主控板到货时间可能影响联调，请保留草稿。";
  const commentDraft = "尚未提交的评论：待场地负责人确认后再同步团队。";
  await riskInput.fill(riskDraft);
  await commentInput.fill(commentDraft);

  const taskCheckbox = page.getByRole("checkbox", { name: "在时间线中显示 整机联调与验收证据整理", exact: true });
  await taskCheckbox.uncheck();
  await expect(page.getByTestId(`timeline-row-project-plan:${fixture.taskId}`)).toHaveCount(0);
  await expect(riskInput).toHaveValue(riskDraft);
  await expect(commentInput).toHaveValue(commentDraft);
  await taskCheckbox.check();
  await expect(page.getByTestId(`timeline-row-project-plan:${fixture.taskId}`)).toBeVisible();
  await page.getByRole("button", { name: "在时间线中定位 整机联调与验收证据整理", exact: true }).click();
  await expect(page.getByTestId("project-timeline-layer")).toBeInViewport();
  await expect(riskInput).toHaveValue(riskDraft);
  await expect(commentInput).toHaveValue(commentDraft);
  await page.getByTestId("project-activity-view").getByRole("button", { name: "评论", exact: true }).click();
  await expect(page.getByRole("heading", { name: "近期动态", exact: true })).toBeVisible();
  await expect(page.getByTestId("project-activity-view").getByText("暂无近期动态", { exact: true })).toBeVisible();
  await expect(riskInput).toHaveValue(riskDraft);
  await expect(commentInput).toHaveValue(commentDraft);
  await expectUnifiedWorkbench(page, "project");

  expect(await prisma.riskRecord.count({ where: { projectId: project.projectId } })).toBe(riskCount);
  expect(await prisma.comment.count({ where: { projectId: project.projectId } })).toBe(commentCount);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});
