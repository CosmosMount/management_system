// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Client } from "pg";
import { prisma } from "../lib/prisma";
import {
  createComment,
  createRisk,
  deleteComment,
  resolveRisk,
} from "../lib/project-management/application/collaboration-service";
import { toProjectManagementServiceError } from "../lib/project-management/application/errors";
import { createTaskDraft, activateTask } from "../lib/project-management/application/lifecycle-service";
import { updateActiveTask } from "../lib/project-management/application/task-mutation-service";
import { updateTaskProject } from "../lib/project-management/application/project-service";
import { createDomainAuditEventTx } from "../lib/project-management/audit";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import {
  getCommentPage,
  getRecentActivityPage,
  getRiskPage,
} from "../lib/project-management/queries/collaboration-queries";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";
import {
  cleanupBarrierResources,
  connectDatabaseClient,
  databaseBackendPid,
  throwBarrierErrors,
  waitForDirectBlockers,
} from "./helpers/database-barrier";

test.describe("Project/Task 风险、评论与近期动态", () => {
  test("桌面端完成主要流程并保持权限、审计、通知和 Project 聚合一致", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "本功能按产品决策只做桌面端专项验收");
    test.setTimeout(90_000);
    const owner = await createActor(`协作功能负责人 ${randomUUID()}`);
    const participant = await createActor(`协作功能参与人 ${randomUUID()}`);
    const outsider = await createActor(`协作功能旁观者 ${randomUUID()}`);
    const projectOnly = await createActor(`仅 Project 协作成员 ${randomUUID()}`);
    const admin = await createActor(
      `协作功能管理员 ${randomUUID()}`,
      "PROJECT_ADMINISTRATOR",
    );
    const inactiveAdmin = await createActor(
      `已停用协作功能管理员 ${randomUUID()}`,
      "PROJECT_ADMINISTRATOR",
    );
    await prisma.person.update({
      where: { id: inactiveAdmin.actor.personId },
      data: { status: "INACTIVE" },
    });
    const draft = await createTaskDraft(owner.actor, {
      title: `协作功能 Task ${randomUUID()}`,
      description: "验证风险、评论和近期动态",
      team: "英雄",
      techGroup: "电控",
      priority: "HIGH",
      members: [
        { personId: owner.actor.personId, role: "OWNER" },
        { personId: participant.actor.personId, role: "PARTICIPANT" },
      ],
      milestones: [milestoneInput("协作功能 Milestone", 2)],
      plannedStartAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      termination: terminationInput(5),
      idempotencyKey: `collaboration-${randomUUID()}`,
    });
    await activateTask(owner.actor, {
      taskId: draft.taskId,
      expectedLockVersion: draft.lockVersion,
    });
    const project = await createActiveProject(owner, participant);
    await prisma.projectMember.create({
      data: {
        projectId: project.id,
        personId: projectOnly.actor.personId,
        role: "PARTICIPANT",
        createdByAccountId: owner.actor.accountId,
      },
    });
    await prisma.task.update({
      where: { id: draft.taskId },
      data: { projectId: project.id },
    });

    const projectRisk = await createRisk(owner.actor, {
      targetType: "PROJECT",
      targetId: project.id,
      content: "Project 自身存在的风险",
    });
    const taskRisk = await createRisk(participant.actor, {
      targetType: "TASK",
      targetId: draft.taskId,
      content: "需要在 Project 汇总区展示的 Task 风险",
    });
    await expectCollaborationNotification({
      eventKey: `pm:risk:${projectRisk.riskId}:created`,
      kind: "risk_created",
      linkPath: `/progress/projects/${project.id}`,
      projectId: project.id,
      expectedRecipients: [owner, participant, projectOnly, admin],
      excludedRecipients: [inactiveAdmin],
    });
    await expectCollaborationNotification({
      eventKey: `pm:risk:${taskRisk.riskId}:created`,
      kind: "risk_created",
      linkPath: `/progress/tasks/${draft.taskId}`,
      taskId: draft.taskId,
      projectId: project.id,
      expectedRecipients: [owner, participant, admin],
      excludedRecipients: [projectOnly, inactiveAdmin],
    });
    expect(
      await prisma.inAppNotification.count({
        where: {
          entityId: { in: [projectRisk.riskId, taskRisk.riskId] },
          recipientAccountId: inactiveAdmin.actor.accountId,
        },
      }),
    ).toBe(0);
    await expectServiceCode(
      createRisk(outsider.actor, {
        targetType: "TASK",
        targetId: draft.taskId,
        content: "旁观者不应能提出 Task 风险",
      }),
      "FORBIDDEN",
    );
    const outsiderComment = await createComment(outsider.actor, {
      targetType: "PROJECT",
      targetId: project.id,
      content: "所有已登录用户都可以发布的 Project 评论",
    });
    await expectCollaborationNotification({
      eventKey: `pm:comment:${outsiderComment.commentId}:created`,
      kind: "comment_created",
      linkPath: `/progress/projects/${project.id}`,
      projectId: project.id,
      expectedRecipients: [owner, participant, outsider, projectOnly, admin],
      excludedRecipients: [inactiveAdmin],
    });
    await prisma.notificationPreference.create({
      data: {
        accountId: outsider.actor.accountId,
        category: "TASK",
        channel: "FEISHU",
        enabled: false,
      },
    });
    const outsiderTaskComment = await createComment(outsider.actor, {
      targetType: "TASK",
      targetId: draft.taskId,
      content: "非 Task 成员操作人仍应收到自己的评论通知",
    });
    await expectCollaborationNotification({
      eventKey: `pm:comment:${outsiderTaskComment.commentId}:created`,
      kind: "comment_created",
      linkPath: `/progress/tasks/${draft.taskId}`,
      taskId: draft.taskId,
      projectId: project.id,
      expectedRecipients: [owner, participant, outsider, admin],
      excludedRecipients: [projectOnly, inactiveAdmin],
    });
    const adminTaskComment = await createComment(admin.actor, {
      targetType: "TASK",
      targetId: draft.taskId,
      content: "全局管理员操作人应按账号去重收到一次通知",
    });
    await expectCollaborationNotification({
      eventKey: `pm:comment:${adminTaskComment.commentId}:created`,
      kind: "comment_created",
      linkPath: `/progress/tasks/${draft.taskId}`,
      taskId: draft.taskId,
      projectId: project.id,
      expectedRecipients: [owner, participant, admin],
      excludedRecipients: [projectOnly, inactiveAdmin],
    });
    await expectServiceCode(
      deleteComment(owner.actor, { commentId: outsiderComment.commentId }),
      "FORBIDDEN",
    );

    const [projectDirectRisks, projectTaskRisks] = await Promise.all([
      getRiskPage(owner.actor, {
        targetType: "PROJECT",
        targetId: project.id,
        source: "DIRECT",
        status: "ACTIVE",
        limit: 20,
      }),
      getRiskPage(owner.actor, {
        targetType: "PROJECT",
        targetId: project.id,
        source: "TASKS",
        status: "ACTIVE",
        limit: 20,
      }),
    ]);
    expect(projectDirectRisks.items.map((risk) => risk.id)).toContain(projectRisk.riskId);
    expect(projectTaskRisks.items.map((risk) => risk.id)).toContain(taskRisk.riskId);

    const oldAudit = await prisma.domainAuditEvent.create({
      data: {
        actorAccountId: owner.actor.accountId,
        actorPersonId: owner.actor.personId,
        action: "pm.task.metadata.update",
        entityType: "Task",
        entityId: draft.taskId,
        taskId: draft.taskId,
        projectId: null,
        after: { title: "旧审计不进入 Project 动态" },
      },
    });
    const newAudit = await prisma.$transaction((tx) =>
      createDomainAuditEventTx(tx, {
        actorAccountId: owner.actor.accountId,
        actorPersonId: owner.actor.personId,
        action: "pm.task.metadata.update",
        entityType: "Task",
        entityId: draft.taskId,
        taskId: draft.taskId,
        after: { title: "新审计自动固化 Project" },
      }),
    );
    expect(newAudit.projectId).toBe(project.id);
    const projectActivity = await getRecentActivityPage(owner.actor, {
      targetType: "PROJECT",
      targetId: project.id,
      category: "ALL",
      limit: 20,
    });
    expect(projectActivity.items.map((item) => item.id)).toContain(newAudit.id);
    expect(projectActivity.items.map((item) => item.id)).not.toContain(oldAudit.id);

    await loginAsTestUser(context, baseURL, {
      openId: owner.openId,
      name: owner.displayName,
    });
    await page.goto(`/progress/tasks/${draft.taskId}`);
    await page.getByTestId("task-activity-view").scrollIntoViewIfNeeded();
    await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
    await page.getByTestId("task-collaboration-view").scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("heading", { name: "任务风险", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "任务评论", exact: true }),
    ).toBeVisible();
    const uiRiskContent = `浏览器提出的风险 ${randomUUID()}`;
    await page.getByLabel("风险内容").fill(uiRiskContent);
    await page.getByRole("button", { name: "提出风险", exact: true }).click();
    await expect(page.getByText(uiRiskContent, { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        prisma.riskRecord.count({
          where: { taskId: draft.taskId, content: uiRiskContent },
        }),
      )
      .toBe(1);
    const uiRisk = await prisma.riskRecord.findFirstOrThrow({
      where: { taskId: draft.taskId, content: uiRiskContent },
    });
    const uiRiskCard = page.locator("article").filter({ hasText: uiRiskContent });
    await uiRiskCard.getByRole("button", { name: "解决风险" }).click();
    await page.getByLabel("解决说明").fill("已通过定向回归确认并关闭");
    await page.getByRole("button", { name: "确认解决" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "风险已解决。" }).first(),
    ).toBeVisible();
    await expect.poll(() => prisma.riskRecord.findUnique({ where: { id: uiRisk.id }, select: { status: true, resolveNote: true } })).toEqual({
      status: "RESOLVED",
      resolveNote: "已通过定向回归确认并关闭",
    });

    const uiCommentContent = `浏览器发布的评论 ${randomUUID()}`;
    await page.getByLabel("发表评论").fill(uiCommentContent);
    await page.getByRole("button", { name: "发布评论" }).click();
    await expect(page.getByText(uiCommentContent, { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        prisma.comment.count({
          where: { taskId: draft.taskId, content: uiCommentContent },
        }),
      )
      .toBe(1);
    const uiComment = await prisma.comment.findFirstOrThrow({
      where: { taskId: draft.taskId, content: uiCommentContent },
      select: { id: true },
    });
    await expectCollaborationNotification({
      eventKey: `pm:comment:${uiComment.id}:created`,
      kind: "comment_created",
      linkPath: `/progress/tasks/${draft.taskId}`,
      taskId: draft.taskId,
      projectId: project.id,
      expectedRecipients: [owner, participant, admin],
      excludedRecipients: [projectOnly, inactiveAdmin],
    });
    await expectHealthyPage(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);

    await loginAsTestUser(context, baseURL, {
      openId: admin.openId,
      name: admin.displayName,
    });
    await page.goto(`/progress/projects/${project.id}`);
    await page.getByTestId("project-collaboration-view").scrollIntoViewIfNeeded();
    const projectCollaboration = page.getByTestId("project-collaboration-view");
    await expect(projectCollaboration).toBeVisible();
    await expect(projectCollaboration.getByRole("heading", { name: "项目自身风险", exact: true })).toBeVisible();
    await expect(projectCollaboration.getByRole("heading", { name: "当前所属任务风险", exact: true })).toBeVisible();
    await expect(projectCollaboration.getByText("Project 自身存在的风险", { exact: true })).toBeVisible();
    await expect(projectCollaboration.getByText("需要在 Project 汇总区展示的 Task 风险", { exact: true })).toBeVisible();
    const commentCard = projectCollaboration.locator("article").filter({ hasText: "所有已登录用户都可以发布的 Project 评论" });
    const notificationCountsBeforeCommentDelete = await Promise.all([
      prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:comment:${outsiderComment.commentId}:` },
        },
      }),
      prisma.inAppNotification.count({
        where: { entityId: outsiderComment.commentId },
      }),
    ]);
    page.once("dialog", (dialog) => void dialog.accept());
    await commentCard.getByRole("button", { name: "删除" }).click();
    await expect(commentCard).toHaveCount(0);
    await expect.poll(() => prisma.comment.findUnique({ where: { id: outsiderComment.commentId }, select: { deletedAt: true } })).not.toEqual({ deletedAt: null });
    await expect(
      Promise.all([
        prisma.notificationOutbox.count({
          where: {
            eventKey: {
              startsWith: `pm:comment:${outsiderComment.commentId}:`,
            },
          },
        }),
        prisma.inAppNotification.count({
          where: { entityId: outsiderComment.commentId },
        }),
      ]),
    ).resolves.toEqual(notificationCountsBeforeCommentDelete);

    await resolveRisk(participant.actor, {
      riskId: projectRisk.riskId,
      resolveNote: "Project 风险已完成回归验证",
    });
    await expectCollaborationNotification({
      eventKey: `pm:risk:${projectRisk.riskId}:resolved`,
      kind: "risk_resolved",
      linkPath: `/progress/projects/${project.id}`,
      projectId: project.id,
      expectedRecipients: [owner, participant, projectOnly, admin],
      excludedRecipients: [inactiveAdmin],
    });

    await prisma.task.update({ where: { id: draft.taskId }, data: { status: "COMPLETED" } });
    await resolveRisk(owner.actor, {
      riskId: taskRisk.riskId,
      resolveNote: "Task 结束后关闭遗留风险",
    });
    await expectCollaborationNotification({
      eventKey: `pm:risk:${taskRisk.riskId}:resolved`,
      kind: "risk_resolved",
      linkPath: `/progress/tasks/${draft.taskId}`,
      taskId: draft.taskId,
      projectId: project.id,
      expectedRecipients: [owner, participant, admin],
      excludedRecipients: [projectOnly, inactiveAdmin],
    });
    await expectServiceCode(
      createRisk(owner.actor, {
        targetType: "TASK",
        targetId: draft.taskId,
        content: "终态 Task 不允许新增风险",
      }),
      "STATE_CONFLICT",
    );

    const secondProject = await createActiveProject(owner, participant);
    const taskBeforeMove = await prisma.task.findUniqueOrThrow({
      where: { id: draft.taskId },
      select: { lockVersion: true },
    });
    await updateTaskProject(owner.actor, {
      taskId: draft.taskId,
      projectId: secondProject.id,
      expectedLockVersion: taskBeforeMove.lockVersion,
    });
    const [oldProjectActivity, newProjectActivity, oldProjectTaskRisks] = await Promise.all([
      getRecentActivityPage(owner.actor, { targetType: "PROJECT", targetId: project.id, category: "TASK", limit: 20 }),
      getRecentActivityPage(owner.actor, { targetType: "PROJECT", targetId: secondProject.id, category: "TASK", limit: 20 }),
      getRiskPage(owner.actor, { targetType: "PROJECT", targetId: project.id, source: "TASKS", status: "RESOLVED", limit: 20 }),
    ]);
    expect(oldProjectActivity.items.some((item) => item.title.includes("移动"))).toBe(true);
    expect(newProjectActivity.items.some((item) => item.title.includes("移动"))).toBe(true);
    expect(oldProjectTaskRisks.items.map((risk) => risk.id)).not.toContain(taskRisk.riskId);

    expect(await prisma.domainAuditEvent.count({ where: { entityId: uiRisk.id, action: { in: ["pm.task.risk.create", "pm.task.risk.resolve"] } } })).toBe(2);
    expect(await prisma.notificationOutbox.count({ where: { eventKey: { startsWith: `pm:risk:${uiRisk.id}:` } } })).toBe(2);
    expect(await prisma.notificationOutbox.count({ where: { eventKey: { startsWith: `pm:comment:${outsiderComment.commentId}:deleted` } } })).toBe(0);
    expect(await prisma.inAppNotification.count({ where: { entityId: uiRisk.id, recipientAccountId: owner.actor.accountId } })).toBe(2);
    expect(await prisma.inAppNotification.count({ where: { entityId: uiRisk.id, recipientAccountId: admin.actor.accountId } })).toBeGreaterThan(0);
  });

  test("协作表单空提交在桌面与移动端标红、聚焦并逐字段清错", async ({
    context,
    page,
    baseURL,
  }, testInfo) => {
    test.setTimeout(60_000);
    const owner = await createActor(`协作字段校验 ${testInfo.project.name} ${randomUUID()}`);
    const draft = await createTaskDraft(owner.actor, {
      title: `协作字段校验 Task ${randomUUID()}`,
      description: "验证风险、解决说明和评论的字段错误",
      team: "英雄",
      techGroup: "电控",
      priority: "MEDIUM",
      members: [{ personId: owner.actor.personId, role: "OWNER" }],
      milestones: [milestoneInput("协作字段校验 Milestone", 2)],
      plannedStartAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      termination: terminationInput(5),
      idempotencyKey: `collaboration-validation-${randomUUID()}`,
    });
    await activateTask(owner.actor, {
      taskId: draft.taskId,
      expectedLockVersion: draft.lockVersion,
    });
    await loginAsTestUser(context, baseURL, {
      openId: owner.openId,
      name: owner.displayName,
    });
    await page.goto(`/progress/tasks/${draft.taskId}`);

    await page.getByTestId("task-collaboration-view").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("time-canvas-root")).toBeVisible();
    const riskInput = page.getByLabel("风险内容");
    await expect(riskInput).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "提出风险", exact: true }).click();
    await expect(riskInput).toHaveAttribute("aria-invalid", "true");
    await expect(riskInput).toBeFocused();
    await expect(page.getByRole("alert").filter({ hasText: "请填写风险内容" })).toBeVisible();
    const riskContent = `字段校验风险 ${randomUUID()}`;
    await riskInput.fill(riskContent);
    await expect(riskInput).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "提出风险", exact: true }).click();

    const riskCard = page.locator("article").filter({ hasText: riskContent });
    await expect(riskCard).toBeVisible();
    const validationRisk = await prisma.riskRecord.findFirstOrThrow({
      where: { taskId: draft.taskId, content: riskContent },
      select: { id: true },
    });
    await riskCard.getByRole("button", { name: "解决风险" }).click();
    const resolveInput = page.getByLabel("解决说明");
    await expect(resolveInput).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "确认解决" }).click();
    await expect(resolveInput).toHaveAttribute("aria-invalid", "true");
    await expect(resolveInput).toBeFocused();
    await expect(page.getByRole("alert").filter({ hasText: "请填写解决说明" })).toBeVisible();
    await resolveInput.fill("已验证解决说明字段错误");
    await expect(resolveInput).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "确认解决" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "风险已解决。" }).first(),
    ).toBeVisible();
    await expect
      .poll(() =>
        prisma.riskRecord.findUnique({
          where: { id: validationRisk.id },
          select: { status: true, resolveNote: true },
        }),
      )
      .toEqual({
        status: "RESOLVED",
        resolveNote: "已验证解决说明字段错误",
      });

    const commentInput = page.getByLabel("发表评论");
    await expect(commentInput).not.toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "发布评论" }).click();
    await expect(commentInput).toHaveAttribute("aria-invalid", "true");
    await expect(commentInput).toBeFocused();
    await expect(page.getByRole("alert").filter({ hasText: "请输入评论内容" })).toBeVisible();
    await commentInput.fill("已验证评论字段错误");
    await expect(commentInput).not.toHaveAttribute("aria-invalid", "true");
    await expectHealthyPage(page);
  });

  test("评论使用 20 条稳定分页并隐藏未知动态 action", async () => {
    const owner = await createActor(`协作分页负责人 ${randomUUID()}`);
    const participant = await createActor(`协作分页参与人 ${randomUUID()}`);
    const project = await createActiveProject(owner, participant);
    const baseTime = Date.now() - 60_000;
    await prisma.comment.createMany({
      data: Array.from({ length: 22 }, (_, index) => ({
        projectId: project.id,
        authorAccountId: owner.actor.accountId,
        authorPersonId: owner.actor.personId,
        authorName: owner.displayName,
        content: `分页评论 ${index}`,
        createdAt: new Date(baseTime + index * 1_000),
        updatedAt: new Date(baseTime + index * 1_000),
      })),
    });
    await prisma.domainAuditEvent.create({
      data: {
        action: "pm.unknown.internal.action",
        entityType: "Project",
        entityId: project.id,
        projectId: project.id,
      },
    });
    const first = await getCommentPage(owner.actor, {
      targetType: "PROJECT",
      targetId: project.id,
      limit: 20,
    });
    expect(first.items).toHaveLength(20);
    expect(first.totalCount).toBe(22);
    expect(first.nextCursor).not.toBeNull();
    const second = await getCommentPage(owner.actor, {
      targetType: "PROJECT",
      targetId: project.id,
      cursor: first.nextCursor,
      limit: 20,
    });
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((comment) => comment.id)).size).toBe(22);
    const activity = await getRecentActivityPage(owner.actor, {
      targetType: "PROJECT",
      targetId: project.id,
      category: "ALL",
      limit: 20,
    });
    expect(activity.items.every((item) => !item.title.includes("unknown"))).toBe(true);
  });

  test("Task 评论与同一操作人的 Task 更新并发时按 Task→Person 顺序完成", async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "数据库锁顺序只需单项目回归");
    test.setTimeout(90_000);

    await createActor(
      `协作并发全局管理员 ${randomUUID()}`,
      "SUPER_ADMINISTRATOR",
    );
    const owner = await createActor(`协作并发负责人 ${randomUUID()}`);
    const participant = await createActor(`协作并发参与人 ${randomUUID()}`);
    const draft = await createTaskDraft(owner.actor, {
      title: `协作并发 Task ${randomUUID()}`,
      description: "验证评论与 Task 更新的锁顺序",
      team: "英雄",
      techGroup: "电控",
      priority: "HIGH",
      members: [
        { personId: owner.actor.personId, role: "OWNER" },
        { personId: participant.actor.personId, role: "PARTICIPANT" },
      ],
      milestones: [milestoneInput("协作并发 Milestone", 2)],
      plannedStartAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      termination: terminationInput(5),
      idempotencyKey: `collaboration-concurrency-${randomUUID()}`,
    });
    await activateTask(owner.actor, {
      taskId: draft.taskId,
      expectedLockVersion: draft.lockVersion,
    });
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: draft.taskId },
      select: { lockVersion: true },
    });
    const commentContent = `并发评论 ${randomUUID()}`;
    const updatedTitle = `并发更新后的 Task ${randomUUID()}`;

    const outcomes = await runBehindPersonLockBarrier({
      personId: owner.actor.personId,
      collaborationWrite: () =>
        createComment(owner.actor, {
          targetType: "TASK",
          targetId: draft.taskId,
          content: commentContent,
        }),
      taskWrite: () =>
        updateActiveTask(owner.actor, {
          taskId: draft.taskId,
          expectedLockVersion: task.lockVersion,
          metadata: {
            title: updatedTitle,
            description: "评论并发时仍应完成元数据更新",
            team: "英雄",
            techGroup: "电控",
            priority: "HIGH",
            relatedTaskId: null,
          },
        }),
    });

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    await expect(
      prisma.comment.count({
        where: { taskId: draft.taskId, content: commentContent },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.task.findUniqueOrThrow({
        where: { id: draft.taskId },
        select: { title: true },
      }),
    ).resolves.toEqual({ title: updatedTitle });
  });
});

async function createActor(
  displayName: string,
  role?: "SUPER_ADMINISTRATOR" | "PROJECT_ADMINISTRATOR",
) {
  const openId = `ou_collaboration_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: { create: { displayName, status: "ACTIVE" } },
      ...(role
        ? { systemRoles: { create: { role, team: "", techGroup: "" } } }
        : {}),
    },
    include: { person: true, systemRoles: true },
  });
  if (!account.person) throw new Error("协作测试账号缺少 Person");
  const actor: ProjectManagementActor = {
    accountId: account.id,
    personId: account.person.id,
    openId,
    unionId: null,
    systemRoles: account.systemRoles.map(({ role: itemRole, team, techGroup }) => ({
      role: itemRole,
      team,
      techGroup,
    })),
  };
  return { actor, openId, displayName };
}

async function createActiveProject(
  owner: Awaited<ReturnType<typeof createActor>>,
  participant: Awaited<ReturnType<typeof createActor>>,
) {
  return prisma.project.create({
    data: {
      name: `协作功能 Project ${randomUUID()}`,
      description: "风险、评论和近期动态定向测试",
      status: "ACTIVE",
      requesterAccountId: owner.actor.accountId,
      startedAt: new Date(),
      members: {
        create: [
          {
            personId: owner.actor.personId,
            role: "OWNER",
            createdByAccountId: owner.actor.accountId,
          },
          {
            personId: participant.actor.personId,
            role: "PARTICIPANT",
            createdByAccountId: owner.actor.accountId,
          },
        ],
      },
    },
  });
}

function milestoneInput(goal: string, daysFromNow: number) {
  return {
    goal,
    completionCriteria: "完成定向验收",
    expectedCompletedAt: new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1_000).toISOString(),
    reviewRequirements: "提供测试证据",
    businessDescription: "协作功能计划节点",
  };
}

function terminationInput(daysFromNow: number) {
  return {
    name: "协作功能 Terminal",
    plannedOutcomeCriteria: "完成全部协作功能验收",
    plannedAt: new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1_000).toISOString(),
    businessDescription: "结束协作功能测试 Task",
  };
}

async function expectCollaborationNotification(input: {
  eventKey: string;
  kind: "risk_created" | "risk_resolved" | "comment_created";
  linkPath: string;
  taskId?: string;
  projectId?: string;
  expectedRecipients: Array<Awaited<ReturnType<typeof createActor>>>;
  excludedRecipients: Array<Awaited<ReturnType<typeof createActor>>>;
}) {
  const outboxes = await prisma.notificationOutbox.findMany({
    where: { eventKey: `${input.eventKey}:feishu` },
    select: { type: true, botKind: true, payload: true },
  });
  expect(outboxes).toHaveLength(1);
  const payload = jsonRecord(JSON.parse(outboxes[0]!.payload));
  expect(outboxes[0]!.type).toBe(input.kind);
  expect(outboxes[0]!.botKind).toBe("notification");
  expect(payload).toMatchObject({
    kind: input.kind,
    purpose: "notification",
    mandatory: false,
    linkPath: input.linkPath,
    taskId: input.taskId ?? null,
    projectId: input.projectId ?? null,
  });

  const globalAdministrators = await prisma.account.findMany({
    where: {
      person: { is: { status: "ACTIVE" } },
      systemRoles: {
        some: {
          role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] },
          team: "",
          techGroup: "",
          revokedAt: null,
        },
      },
    },
    select: { id: true },
  });
  const excludedAccountIds = new Set(
    input.excludedRecipients.map((recipient) => recipient.actor.accountId),
  );
  const expectedAccountIds = [
    ...new Set([
      ...input.expectedRecipients.map(
        (recipient) => recipient.actor.accountId,
      ),
      ...globalAdministrators.map((administrator) => administrator.id),
    ]),
  ]
    .filter((accountId) => !excludedAccountIds.has(accountId))
    .sort();
  const disabledFeishuAccountIds = new Set(
    (
      await prisma.notificationPreference.findMany({
        where: {
          accountId: { in: expectedAccountIds },
          category: input.taskId ? "TASK" : "PROJECT",
          channel: "FEISHU",
          enabled: false,
        },
        select: { accountId: true },
      })
    ).map((preference) => preference.accountId),
  );
  const expectedRecipientAccounts = await prisma.account.findMany({
    where: { id: { in: expectedAccountIds } },
    select: {
      id: true,
      identities: {
        where: { provider: "FEISHU", tenantId: "default" },
        select: { openId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  const expectedOpenIds = expectedRecipientAccounts
    .filter((account) => !disabledFeishuAccountIds.has(account.id))
    .flatMap((account) => {
      const openId = account.identities
        .map((identity) => identity.openId?.trim())
        .find((candidate): candidate is string => Boolean(candidate));
      return openId ? [openId] : [];
    })
    .sort();

  const recipientOpenIds = jsonStringArray(payload.recipientOpenIds);
  expect(recipientOpenIds).toHaveLength(new Set(recipientOpenIds).size);
  expect([...recipientOpenIds].sort()).toEqual(expectedOpenIds);
  const inAppNotifications = await prisma.inAppNotification.findMany({
    where: { eventKey: { startsWith: `${input.eventKey}:inapp:` } },
    select: {
      recipientAccountId: true,
      taskId: true,
      projectId: true,
      linkPath: true,
      payload: true,
    },
  });
  const inAppAccountIds = inAppNotifications.map(
    (notification) => notification.recipientAccountId,
  );
  expect(inAppAccountIds).toHaveLength(new Set(inAppAccountIds).size);
  expect([...inAppAccountIds].sort()).toEqual(expectedAccountIds);
  for (const notification of inAppNotifications) {
    expect(notification).toMatchObject({
      taskId: input.taskId ?? null,
      projectId: input.projectId ?? null,
      linkPath: input.linkPath,
    });
    expect(jsonRecord(notification.payload)).toMatchObject({
      kind: input.kind,
      linkPath: input.linkPath,
      recipientOpenIds: [],
    });
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("测试期望 JSON object");
}

function jsonStringArray(value: unknown): string[] {
  if (
    Array.isArray(value) &&
    value.every((entry): entry is string => typeof entry === "string")
  ) {
    return value;
  }
  throw new Error("测试期望 JSON string array");
}

async function expectServiceCode(promise: Promise<unknown>, code: string) {
  await expect(
    promise.catch((error) => {
      throw toProjectManagementServiceError(error);
    }),
  ).rejects.toMatchObject({ code });
}

async function runBehindPersonLockBarrier(input: {
  personId: string;
  collaborationWrite: () => Promise<unknown>;
  taskWrite: () => Promise<unknown>;
}): Promise<
  [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]
> {
  let locker: Client | undefined;
  let observer: Client | undefined;
  let transactionMayBeOpen = false;
  let released = false;
  let pending: Promise<unknown>[] = [];
  let pendingSettlement:
    | Promise<PromiseSettledResult<unknown>[]>
    | undefined;
  let pendingBackendPids: number[] = [];
  let pendingHandled = false;
  let result:
    | [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]
    | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    locker = await connectDatabaseClient("collaboration-person-locker");
    observer = await connectDatabaseClient("collaboration-person-observer");
    transactionMayBeOpen = true;
    const lockerPid = await lockPersonRow(locker, input.personId);
    const collaborationPromise = Promise.resolve().then(
      input.collaborationWrite,
    );
    void collaborationPromise.catch(() => undefined);
    pending = [collaborationPromise];
    pendingSettlement = Promise.allSettled(pending);
    await waitForDirectBlockers(observer, lockerPid, 1);

    const taskPromise = Promise.resolve().then(input.taskWrite);
    void taskPromise.catch(() => undefined);
    pending = [collaborationPromise, taskPromise];
    pendingSettlement = Promise.allSettled(pending);
    pendingBackendPids = await waitForDirectBlockers(observer, lockerPid, 2);
    await locker.query("COMMIT");
    released = true;
    const settled = await Promise.allSettled(pending);
    pendingHandled = true;
    if (settled.length !== 2) throw new Error("协作并发屏障结果数量错误");
    result = [settled[0]!, settled[1]!];
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }
  const cleanupErrors = await cleanupBarrierResources({
    locker,
    observer,
    rollbackRequired: Boolean(locker && transactionMayBeOpen && !released),
    pendingSettlement,
    pendingBackendPids,
    pendingHandled,
    primaryError,
  });
  throwBarrierErrors(hasPrimaryError, primaryError, cleanupErrors);
  if (!result) throw new Error("协作并发屏障未返回结果");
  return result;
}

async function lockPersonRow(client: Client, personId: string) {
  await client.query("BEGIN");
  const pid = await databaseBackendPid(client);
  await client.query('SELECT "id" FROM "Person" WHERE "id" = $1 FOR UPDATE', [
    personId,
  ]);
  return pid;
}
