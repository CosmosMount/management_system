// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { createRisk } from "../lib/project-management/application/collaboration-service";
import { createProject, reviewProjectEstablishment } from "../lib/project-management/application/project-service";
import { actor, createUiFixture } from "./helpers/project-management-ui-fixtures";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

test("Project desktop overview stays above 700px and preserves risk and comment drafts across views", async ({ context, page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "本轮项目分区以桌面体验为验收范围");
  test.setTimeout(120_000);
  const fixture = await createUiFixture();
  const owner = actor(fixture.owner);
  const administrator = {
    ...actor(fixture.admin),
    systemRoles: [{ role: "PROJECT_ADMINISTRATOR" as const, team: "", techGroup: "" }],
  };
  const projectName = `项目分区草稿保留 ${randomUUID()}`;
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

  const navigation = page.getByRole("navigation", { name: "项目详情视图" });
  const overviewLink = navigation.getByRole("link", { name: "任务概览", exact: true });
  const collaborationLink = navigation.getByRole("link", { name: "风险与讨论", exact: true });
  const planLink = navigation.getByRole("link", { name: "计划与投入", exact: true });
  const activityLink = navigation.getByRole("link", { name: "活动记录", exact: true });
  await expect(overviewLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1, name: projectName })).toBeVisible();
  await expect(page.getByTestId("time-canvas-root")).toHaveCount(0);
  await expect(page.getByTestId("project-tasks")).toBeInViewport();
  await expect(page.getByTestId("project-risk-summary")).toBeInViewport();
  const taskTop = await page.getByTestId("project-tasks").evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
  expect(taskTop).toBeLessThan(700);
  await page.screenshot({ path: testInfo.outputPath("project-views-desktop-overview.png"), animations: "disabled" });

  await page.getByTestId("project-risk-summary").getByRole("link", { name: "查看全部风险与讨论" }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("section") === "collaboration" && url.hash === "#risks");
  await expect(collaborationLink).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#risks")).toBeInViewport();
  await page.getByTestId("project-collaboration-view").locator("summary").filter({ hasText: "提出项目风险" }).click();
  const riskInput = page.getByLabel("风险内容", { exact: true });
  const commentInput = page.getByLabel("发表评论", { exact: true });
  const riskDraft = "尚未提交的风险：主控板到货时间可能影响联调，请保留草稿。";
  const commentDraft = "尚未提交的评论：待场地负责人确认后再同步团队。";
  await riskInput.fill(riskDraft);
  await commentInput.fill(commentDraft);

  await overviewLink.click();
  await expect(overviewLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("project-tasks")).toBeVisible();
  await expect(page.getByTestId("project-collaboration-view")).not.toBeVisible();
  await expect(page.getByTestId("time-canvas-root")).toHaveCount(0);
  await collaborationLink.click();
  await expect(collaborationLink).toHaveAttribute("aria-current", "page");
  await expect(riskInput).toBeVisible();
  await expect(commentInput).toBeVisible();
  await expect(riskInput).toHaveValue(riskDraft);
  await expect(commentInput).toHaveValue(commentDraft);

  await planLink.click();
  await expect(planLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("project-timeline-layer")).toBeVisible();
  await expect(page.getByTestId("time-canvas-root")).toHaveCount(1);
  await collaborationLink.click();
  await expect(collaborationLink).toHaveAttribute("aria-current", "page");
  await expect(riskInput).toBeVisible();
  await expect(commentInput).toBeVisible();
  await expect(riskInput).toHaveValue(riskDraft);
  await expect(commentInput).toHaveValue(commentDraft);

  await activityLink.click();
  await expect(activityLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "近期动态", exact: true })).toBeVisible();
  await page.goBack();
  await expect(collaborationLink).toHaveAttribute("aria-current", "page");
  await expect(riskInput).toBeVisible();
  await expect(commentInput).toBeVisible();
  await expect(riskInput).toHaveValue(riskDraft);
  await expect(commentInput).toHaveValue(commentDraft);
  await page.goForward();
  await expect(activityLink).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "近期动态", exact: true })).toBeVisible();
  await collaborationLink.click();
  await expect(collaborationLink).toHaveAttribute("aria-current", "page");
  await expect(riskInput).toBeVisible();
  await expect(commentInput).toBeVisible();
  await expect(riskInput).toHaveValue(riskDraft);
  await expect(commentInput).toHaveValue(commentDraft);

  expect(await prisma.riskRecord.count({ where: { projectId: project.projectId } })).toBe(riskCount);
  expect(await prisma.comment.count({ where: { projectId: project.projectId } })).toBe(commentCount);
  await expectHealthyPage(page);
  expect(errors).toEqual([]);
});
