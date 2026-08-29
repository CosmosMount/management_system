// @playwright-project node-db
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import {
  getCommentPage,
  getRecentActivityPage,
  getRiskPage,
} from "../lib/project-management/queries/collaboration-queries";
import { listInAppNotifications } from "../lib/project-management/queries/notification-queries";
import { listTasks } from "../lib/project-management/queries/task-queries";
import {
  createPaginationActor,
  createPaginationProject,
  createPaginationTaskRows,
  grantPaginationAdministrator,
} from "./helpers/project-management-pagination-fixtures";

test.describe("project management query pagination", () => {
  test("notification pages use stable composite cursors without cross-account or filter reuse", async () => {
    const first = await createPaginationActor("通知分页 A");
    const second = await createPaginationActor("通知分页 B");
    const createdAt = new Date("2026-08-29T08:00:00.000Z");
    const ids = Array.from({ length: 5 }, () => randomUUID()).sort().reverse();
    await prisma.inAppNotification.createMany({
      data: [
        ...ids.map((id, index) => ({
          id,
          eventKey: `pagination-notification-${id}`,
          recipientAccountId: first.accountId,
          category: "TASK" as const,
          title: `通知 ${index}`,
          summary: "分页回归",
          entityType: "Task",
          entityId: randomUUID(),
          linkPath: "/progress/tasks",
          payload: {},
          createdAt,
        })),
        {
          id: randomUUID(),
          eventKey: `pagination-review-${randomUUID()}`,
          recipientAccountId: first.accountId,
          category: "REVIEW" as const,
          title: "其他分类",
          summary: "不能作为 TASK 游标",
          entityType: "Task",
          entityId: randomUUID(),
          linkPath: "/progress/tasks",
          payload: {},
          createdAt,
        },
        {
          id: randomUUID(),
          eventKey: `pagination-other-account-${randomUUID()}`,
          recipientAccountId: second.accountId,
          category: "TASK" as const,
          title: "其他账号",
          summary: "不能读取",
          entityType: "Task",
          entityId: randomUUID(),
          linkPath: "/progress/tasks",
          payload: {},
          createdAt,
        },
      ],
    });

    const firstPage = await listInAppNotifications({
      actor: first,
      input: { category: "TASK", limit: 2 },
    });
    const secondPage = await listInAppNotifications({
      actor: first,
      input: { category: "TASK", limit: 2, cursor: firstPage.nextCursor },
    });
    const thirdPage = await listInAppNotifications({
      actor: first,
      input: { category: "TASK", limit: 2, cursor: secondPage.nextCursor },
    });

    expect([
      ...firstPage.items,
      ...secondPage.items,
      ...thirdPage.items,
    ].map((item) => item.id)).toEqual(ids);
    expect(new Set([
      ...firstPage.items,
      ...secondPage.items,
      ...thirdPage.items,
    ].map((item) => item.id)).size).toBe(ids.length);
    expect(thirdPage.nextCursor).toBeNull();
    await expect(
      listInAppNotifications({
        actor: second,
        input: { category: "TASK", limit: 2, cursor: firstPage.nextCursor },
      }),
    ).rejects.toThrow("通知分页游标无效");
    await expect(
      listInAppNotifications({
        actor: first,
        input: { category: "REVIEW", limit: 2, cursor: firstPage.nextCursor },
      }),
    ).rejects.toThrow("通知分页游标无效");
    await expect(
      listInAppNotifications({
        actor: first,
        input: {
          category: "TASK",
          unreadOnly: true,
          limit: 2,
          cursor: firstPage.nextCursor,
        },
      }),
    ).rejects.toThrow("通知分页游标无效");
  });

  test("Task pages keep timestamp/id ordering and validate the current filter anchor", async () => {
    const first = await createPaginationActor("Task 分页 A");
    const second = await createPaginationActor("Task 分页 B");
    await grantPaginationAdministrator(first.accountId);
    const updatedAt = new Date("2026-08-29T09:00:00.000Z");
    const ids = Array.from({ length: 5 }, () => randomUUID()).sort().reverse();
    await createPaginationTaskRows({
      accountId: first.accountId,
      personId: first.personId,
      rows: ids.map((id, index) => ({
        id,
        status: "ACTIVE",
        title: `分页 Task ${index}`,
        updatedAt,
      })),
    });

    const firstPage = await listTasks({
      actor: first,
      input: { status: "ACTIVE", mine: true, limit: 2 },
    });
    const secondPage = await listTasks({
      actor: first,
      input: {
        status: "ACTIVE",
        mine: true,
        limit: 2,
        cursor: firstPage.nextCursor ?? undefined,
      },
    });
    const thirdPage = await listTasks({
      actor: first,
      input: {
        status: "ACTIVE",
        mine: true,
        limit: 2,
        cursor: secondPage.nextCursor ?? undefined,
      },
    });

    expect([
      ...firstPage.items,
      ...secondPage.items,
      ...thirdPage.items,
    ].map((item) => item.id)).toEqual(ids);
    expect(thirdPage.nextCursor).toBeNull();
    await expect(
      listTasks({
        actor: second,
        input: {
          status: "ACTIVE",
          mine: true,
          limit: 2,
          cursor: firstPage.nextCursor ?? undefined,
        },
      }),
    ).rejects.toThrow("Task 分页游标无效");
    await expect(
      listTasks({
        actor: first,
        input: {
          status: "DRAFT",
          mine: true,
          limit: 2,
          cursor: firstPage.nextCursor ?? undefined,
        },
      }),
    ).rejects.toThrow("Task 分页游标无效");
    await expect(
      listTasks({
        actor: first,
        input: {
          status: "ACTIVE",
          priority: "MEDIUM",
          mine: true,
          limit: 2,
          cursor: firstPage.nextCursor ?? undefined,
        },
      }),
    ).rejects.toThrow("Task 分页游标无效");
    const allTasksPage = await listTasks({
      actor: first,
      input: { status: "ACTIVE", mine: false, limit: 2 },
    });
    await expect(
      listTasks({
        actor: second,
        input: {
          status: "ACTIVE",
          mine: false,
          limit: 2,
          cursor: allTasksPage.nextCursor ?? undefined,
        },
      }),
    ).rejects.toThrow("Task 分页游标无效");
    await expect(
      listTasks({
        actor: first,
        input: {
          query: "分页 Task",
          limit: 2,
          cursor: "查询模式忽略该值",
        },
      }),
    ).resolves.toMatchObject({ nextCursor: null, hasMoreByQuery: true });
  });

  test("risk and activity cursors keep stable ordering within their object and filter scope", async () => {
    const actor = await createPaginationActor("协作分页负责人");
    const firstProject = await createPaginationProject(
      actor,
      `协作分页 Project A ${randomUUID()}`,
    );
    const secondProject = await createPaginationProject(
      actor,
      `协作分页 Project B ${randomUUID()}`,
    );
    const createdAt = new Date("2026-08-29T11:00:00.000Z");
    const riskIds = Array.from({ length: 5 }, () => randomUUID()).sort().reverse();
    await prisma.riskRecord.createMany({
      data: [
        ...riskIds.map((id, index) => ({
          id,
          projectId: firstProject.id,
          content: `稳定分页风险 ${index}`,
          createdByAccountId: actor.accountId,
          createdByPersonId: actor.personId,
          createdByName: "协作分页负责人",
          createdAt,
          updatedAt: createdAt,
        })),
        {
          id: randomUUID(),
          projectId: firstProject.id,
          content: "已解决筛选锚点",
          status: "RESOLVED" as const,
          createdByAccountId: actor.accountId,
          createdByPersonId: actor.personId,
          createdByName: "协作分页负责人",
          resolvedByAccountId: actor.accountId,
          resolvedByPersonId: actor.personId,
          resolvedByName: "协作分页负责人",
          resolveNote: "已处理",
          resolvedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        },
        {
          id: randomUUID(),
          projectId: secondProject.id,
          content: "其他 Project 风险",
          createdByAccountId: actor.accountId,
          createdByPersonId: actor.personId,
          createdByName: "协作分页负责人",
          createdAt,
          updatedAt: createdAt,
        },
      ],
    });

    const firstRiskPage = await getRiskPage(actor, {
      targetType: "PROJECT",
      targetId: firstProject.id,
      source: "DIRECT",
      status: "ACTIVE",
      limit: 2,
    });
    const secondRiskPage = await getRiskPage(actor, {
      targetType: "PROJECT",
      targetId: firstProject.id,
      source: "DIRECT",
      status: "ACTIVE",
      cursor: firstRiskPage.nextCursor,
      limit: 2,
    });
    const thirdRiskPage = await getRiskPage(actor, {
      targetType: "PROJECT",
      targetId: firstProject.id,
      source: "DIRECT",
      status: "ACTIVE",
      cursor: secondRiskPage.nextCursor,
      limit: 2,
    });
    expect(
      [...firstRiskPage.items, ...secondRiskPage.items, ...thirdRiskPage.items].map(
        (item) => item.id,
      ),
    ).toEqual(riskIds);
    await expect(
      getRiskPage(actor, {
        targetType: "PROJECT",
        targetId: firstProject.id,
        source: "DIRECT",
        status: "RESOLVED",
        cursor: firstRiskPage.nextCursor,
        limit: 2,
      }),
    ).rejects.toThrow("风险分页游标无效");
    await expect(
      getRecentActivityPage(actor, {
        targetType: "PROJECT",
        targetId: firstProject.id,
        category: "PROJECT",
        cursor: firstRiskPage.nextCursor,
        limit: 2,
      }),
    ).rejects.toThrow("动态分页游标无效");
    await expect(
      getCommentPage(actor, {
        targetType: "PROJECT",
        targetId: firstProject.id,
        cursor: firstRiskPage.nextCursor,
        limit: 2,
      }),
    ).rejects.toThrow("评论分页游标无效");
    await expect(
      getRiskPage(actor, {
        targetType: "PROJECT",
        targetId: secondProject.id,
        source: "DIRECT",
        status: "ACTIVE",
        cursor: firstRiskPage.nextCursor,
        limit: 2,
      }),
    ).rejects.toThrow("风险分页游标无效");

    const taskId = randomUUID();
    await createPaginationTaskRows({
      accountId: actor.accountId,
      personId: actor.personId,
      rows: [
        {
          id: taskId,
          status: "ACTIVE",
          title: "协作分页 Task",
          updatedAt: createdAt,
        },
      ],
    });
    await prisma.task.update({
      where: { id: taskId },
      data: { projectId: firstProject.id },
    });
    await prisma.riskRecord.createMany({
      data: Array.from({ length: 2 }, (_, index) => ({
        taskId,
        content: `Task 聚合风险 ${index}`,
        createdByAccountId: actor.accountId,
        createdByPersonId: actor.personId,
        createdByName: "协作分页负责人",
        createdAt,
        updatedAt: createdAt,
      })),
    });
    const taskRiskPage = await getRiskPage(actor, {
      targetType: "PROJECT",
      targetId: firstProject.id,
      source: "TASKS",
      status: "ACTIVE",
      limit: 1,
    });
    expect(taskRiskPage.nextCursor).not.toBeNull();
    await expect(
      getRiskPage(actor, {
        targetType: "TASK",
        targetId: taskId,
        source: "DIRECT",
        status: "ACTIVE",
        cursor: taskRiskPage.nextCursor,
        limit: 1,
      }),
    ).rejects.toThrow("风险分页游标无效");

    const activityIds = Array.from(
      { length: 5 },
      (_, index) =>
        `ffffffff-ffff-4fff-bfff-${String(index + 1).padStart(12, "0")}`,
    )
      .sort()
      .reverse();
    await prisma.domainAuditEvent.createMany({
      data: [
        ...activityIds.map((id, index) => ({
          id,
          actorAccountId: actor.accountId,
          actorPersonId: actor.personId,
          action: "pm.project.metadata.update",
          entityType: "Project",
          entityId: firstProject.id,
          projectId: firstProject.id,
          before: { name: `旧名称 ${index}` },
          after: { name: `稳定分页动态 ${index}` },
          createdAt,
        })),
        {
          id: "00000000-0000-4000-8000-000000000001",
          actorAccountId: actor.accountId,
          actorPersonId: actor.personId,
          action: "pm.project.risk.create",
          entityType: "RiskRecord",
          entityId: randomUUID(),
          projectId: firstProject.id,
          createdAt,
        },
        {
          id: randomUUID(),
          actorAccountId: actor.accountId,
          actorPersonId: actor.personId,
          action: "pm.project.metadata.update",
          entityType: "Project",
          entityId: secondProject.id,
          projectId: secondProject.id,
          createdAt,
        },
      ],
    });
    const firstActivityPage = await getRecentActivityPage(actor, {
      targetType: "PROJECT",
      targetId: firstProject.id,
      category: "PROJECT",
      limit: 2,
    });
    const secondActivityPage = await getRecentActivityPage(actor, {
      targetType: "PROJECT",
      targetId: firstProject.id,
      category: "PROJECT",
      cursor: firstActivityPage.nextCursor,
      limit: 2,
    });
    const thirdActivityPage = await getRecentActivityPage(actor, {
      targetType: "PROJECT",
      targetId: firstProject.id,
      category: "PROJECT",
      cursor: secondActivityPage.nextCursor,
      limit: 2,
    });
    expect(
      [
        ...firstActivityPage.items,
        ...secondActivityPage.items,
        ...thirdActivityPage.items,
      ].map((item) => item.id),
    ).toEqual(activityIds);
    await expect(
      getRecentActivityPage(actor, {
        targetType: "PROJECT",
        targetId: firstProject.id,
        category: "RISK",
        cursor: firstActivityPage.nextCursor,
        limit: 2,
      }),
    ).rejects.toThrow("动态分页游标无效");
    await expect(
      getRecentActivityPage(actor, {
        targetType: "PROJECT",
        targetId: secondProject.id,
        category: "PROJECT",
        cursor: firstActivityPage.nextCursor,
        limit: 2,
      }),
    ).rejects.toThrow("动态分页游标无效");
    const allActivityPage = await getRecentActivityPage(actor, {
      targetType: "PROJECT",
      targetId: firstProject.id,
      category: "ALL",
      limit: 2,
    });
    expect(allActivityPage.nextCursor).not.toBeNull();
    await expect(
      getRecentActivityPage(actor, {
        targetType: "PROJECT",
        targetId: firstProject.id,
        category: "PROJECT",
        cursor: allActivityPage.nextCursor,
        limit: 2,
      }),
    ).rejects.toThrow("动态分页游标无效");

    const taskActivityCreatedAt = new Date(createdAt.getTime() + 1_000);
    await prisma.domainAuditEvent.createMany({
      data: Array.from({ length: 2 }, () => ({
        actorAccountId: actor.accountId,
        actorPersonId: actor.personId,
        action: "pm.task.metadata.update",
        entityType: "Task",
        entityId: taskId,
        projectId: firstProject.id,
        taskId,
        createdAt: taskActivityCreatedAt,
      })),
    });
    const projectTaskActivityPage = await getRecentActivityPage(actor, {
      targetType: "PROJECT",
      targetId: firstProject.id,
      category: "TASK",
      limit: 1,
    });
    expect(projectTaskActivityPage.nextCursor).not.toBeNull();
    await expect(
      getRecentActivityPage(actor, {
        targetType: "TASK",
        targetId: taskId,
        category: "TASK",
        cursor: projectTaskActivityPage.nextCursor,
        limit: 1,
      }),
    ).rejects.toThrow("动态分页游标无效");
    const invalidUuidCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        kind: "ACTIVITY",
        scope: JSON.stringify({
          targetType: "PROJECT",
          targetId: firstProject.id,
          category: "PROJECT",
        }),
        timestamp: createdAt.toISOString(),
        id: "not-a-uuid",
      }),
    ).toString("base64url");
    await expect(
      getRecentActivityPage(actor, {
        targetType: "PROJECT",
        targetId: firstProject.id,
        category: "PROJECT",
        cursor: invalidUuidCursor,
        limit: 2,
      }),
    ).rejects.toThrow("动态分页游标无效");
  });
});
