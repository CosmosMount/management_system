// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { expectUnifiedWorkbench } from "./helpers/workbench-layout";
import { prisma } from "../lib/prisma";
import { createRisk } from "../lib/project-management/application/collaboration-service";
import { createProject, reviewProjectEstablishment } from "../lib/project-management/application/project-service";
import { actor, createUiFixture } from "./helpers/project-management-ui-fixtures";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

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
  await expect(page.getByRole("heading", { level: 1, name: projectName })).toHaveCount(1);
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
