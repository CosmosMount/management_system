// @playwright-project node-db
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import { listInAppNotifications } from "../lib/project-management/queries/notification-queries";
import { listTasks } from "../lib/project-management/queries/task-queries";
import {
  createPaginationActor,
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
});
