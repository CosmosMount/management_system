import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import {
  createComment,
  createRisk,
  deleteComment,
  resolveRisk,
} from "../lib/project-management/application/collaboration-service";
import { toProjectManagementServiceError } from "../lib/project-management/application/errors";
import { createTaskDraft, activateTask } from "../lib/project-management/application/lifecycle-service";
import { updateTaskProject } from "../lib/project-management/application/project-service";
import { createDomainAuditEventTx } from "../lib/project-management/audit";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import {
  getCommentPage,
  getRecentActivityPage,
  getRiskPage,
} from "../lib/project-management/queries/collaboration-queries";
import { expectHealthyPage, loginAsTestUser } from "./helpers/functional-fixtures";

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
      tagIds: [],
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
    await expect(page.getByRole("heading", { name: "Task 风险" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Task 评论" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "近期动态" })).toBeVisible();
    const uiRiskContent = `浏览器提出的风险 ${randomUUID()}`;
    await page.getByLabel("风险内容").fill(uiRiskContent);
    await page.getByRole("button", { name: "提出风险", exact: true }).click();
    await expect(page.getByText(uiRiskContent, { exact: true })).toBeVisible();
    const uiRisk = await prisma.riskRecord.findFirstOrThrow({
      where: { taskId: draft.taskId, content: uiRiskContent },
    });
    const uiRiskCard = page.locator("article").filter({ hasText: uiRiskContent });
    await uiRiskCard.getByRole("button", { name: "解决风险" }).click();
    await page.getByLabel("解决说明").fill("已通过定向回归确认并关闭");
    await page.getByRole("button", { name: "确认解决" }).click();
    await expect(page.getByText("风险已解决。")).toBeVisible();
    await expect.poll(() => prisma.riskRecord.findUnique({ where: { id: uiRisk.id }, select: { status: true, resolveNote: true } })).toEqual({
      status: "RESOLVED",
      resolveNote: "已通过定向回归确认并关闭",
    });

    const uiCommentContent = `浏览器发布的评论 ${randomUUID()}`;
    await page.getByLabel("发表评论").fill(uiCommentContent);
    await page.getByRole("button", { name: "发布评论" }).click();
    await expect(page.getByText(uiCommentContent, { exact: true })).toBeVisible();
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
    await expect(page.getByText("Project 自身风险", { exact: true })).toBeVisible();
    await expect(page.getByText("当前所属 Task 风险", { exact: true })).toBeVisible();
    await expect(page.getByText("Project 自身存在的风险", { exact: true })).toBeVisible();
    await expect(page.getByText("需要在 Project 汇总区展示的 Task 风险", { exact: true })).toBeVisible();
    const commentCard = page.locator("article").filter({ hasText: "所有已登录用户都可以发布的 Project 评论" });
    page.once("dialog", (dialog) => void dialog.accept());
    await commentCard.getByRole("button", { name: "删除" }).click();
    await expect(commentCard).toHaveCount(0);
    await expect.poll(() => prisma.comment.findUnique({ where: { id: outsiderComment.commentId }, select: { deletedAt: true } })).not.toEqual({ deletedAt: null });

    await prisma.task.update({ where: { id: draft.taskId }, data: { status: "COMPLETED" } });
    await resolveRisk(owner.actor, {
      riskId: taskRisk.riskId,
      resolveNote: "Task 结束后关闭遗留风险",
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
    expect(await prisma.inAppNotification.count({ where: { entityId: uiRisk.id, recipientAccountId: owner.actor.accountId } })).toBe(0);
    expect(await prisma.inAppNotification.count({ where: { entityId: uiRisk.id, recipientAccountId: admin.actor.accountId } })).toBeGreaterThan(0);
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

async function expectServiceCode(promise: Promise<unknown>, code: string) {
  await expect(
    promise.catch((error) => {
      throw toProjectManagementServiceError(error);
    }),
  ).rejects.toMatchObject({ code });
}
