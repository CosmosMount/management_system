// @playwright-project ui
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import {
  createPaginationActor,
  createPaginationProject,
  createPaginationTaskRows,
  grantPaginationAdministrator,
} from "./helpers/project-management-pagination-fixtures";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

test("notification, Task, risk, and activity records beyond the first page remain reachable", async ({
  context,
  page,
  baseURL,
}) => {
  const actor = await createPaginationActor(`UI 分页 ${randomUUID()}`);
  await grantPaginationAdministrator(actor.accountId);
  const timestamp = new Date("2099-08-29T10:00:00.000Z");
  const notificationIds = Array.from(
    { length: 51 },
    () => randomUUID(),
  ).sort().reverse();
  const taskIds = Array.from({ length: 51 }, () => randomUUID()).sort().reverse();
  await prisma.inAppNotification.createMany({
    data: notificationIds.map((id, index) => ({
      id,
      eventKey: `ui-pagination-notification-${id}`,
      recipientAccountId: actor.accountId,
      category: "TASK" as const,
      title: `UI 分页通知 ${index}`,
      summary: "验证第 51 条通知可达",
      entityType: "Task",
      entityId: randomUUID(),
      linkPath: "/progress/tasks",
      payload: {},
      createdAt: timestamp,
    })),
  });
  await createPaginationTaskRows({
    accountId: actor.accountId,
    personId: actor.personId,
    rows: taskIds.map((id, index) => ({
      id,
      status: "ACTIVE",
      title: `UI 分页 Task ${index}`,
      updatedAt: timestamp,
    })),
  });
  await loginAsTestUser(context, baseURL, {
    openId: actor.openId,
    name: "UI 分页用户",
  });

  await page.goto("/progress/notifications?category=TASK&unread=1");
  await expect(page.getByText("UI 分页通知 0", { exact: true })).toBeVisible();
  await expect(page.getByText("UI 分页通知 50", { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "下一页通知" }).click();
  await expect(page).toHaveURL(/category=TASK.*unread=1.*cursor=/);
  await expect(page.getByText("UI 分页通知 50", { exact: true })).toBeVisible();
  await expectHealthyPage(page);
  await page.goto(
    "/progress/notifications?category=TASK&unread=1&cursor=malformed",
  );
  await expect(page).toHaveURL(/category=TASK.*unread=1.*cursorError=1/);
  await expect(page).not.toHaveURL(/(?:\?|&)cursor=/);
  await expect(
    page.getByRole("alert").getByText("通知列表已变化，已为你返回第一页。"),
  ).toBeVisible();
  await expectHealthyPage(page);
  await page.goto(
    "/progress/notifications?category=TASK&unread=1&cursor=%20",
  );
  await expect(page).toHaveURL(/category=TASK.*unread=1.*cursorError=1/);
  await expect(
    page.getByRole("alert").getByText("通知列表已变化，已为你返回第一页。"),
  ).toBeVisible();
  await expectHealthyPage(page);

  await page.goto("/progress/tasks");
  await expect(page.getByText("UI 分页 Task 0", { exact: true })).toBeVisible();
  await expect(page.getByText("UI 分页 Task 50", { exact: true })).toHaveCount(0);
  const nextTaskHref = await page
    .getByRole("link", { name: "下一页任务" })
    .getAttribute("href");
  expect(nextTaskHref).not.toBeNull();
  await page.getByRole("link", { name: "下一页任务" }).click();
  await expect(page).toHaveURL(/cursor=/);
  await expect(page.getByText("UI 分页 Task 50", { exact: true })).toBeVisible();
  await expectHealthyPage(page);

  await page.goto("/progress/tasks?q=UI+分页+Task&cursor=malformed");
  await expect(page.getByRole("status")).toContainText("仅显示最相关的 50 条");
  await expect(page.getByRole("link", { name: "下一页任务" })).toHaveCount(0);
  await expectHealthyPage(page);

  const anchorId = cursorIdFromHref(nextTaskHref!);
  await prisma.task.update({
    where: { id: anchorId },
    data: { updatedAt: new Date("2099-08-29T10:00:01.000Z") },
  });
  await page.goto(nextTaskHref!);
  await expect(page).toHaveURL(/cursorError=1/);
  await expect(page).not.toHaveURL(/(?:\?|&)cursor=/);
  await expect(
    page.getByRole("alert").getByText("任务列表已变化，已为你返回第一页。"),
  ).toBeVisible();
  await expectHealthyPage(page);

  const project = await createPaginationProject(
    actor,
    `UI 协作分页 Project ${randomUUID()}`,
  );
  const collaborationTimestamp = new Date("2099-08-29T11:00:00.000Z");
  const riskIds = Array.from({ length: 21 }, () => randomUUID()).sort().reverse();
  const activityIds = Array.from({ length: 21 }, () => randomUUID())
    .sort()
    .reverse();
  await prisma.riskRecord.createMany({
    data: riskIds.map((id, index) => ({
      id,
      projectId: project.id,
      content: `UI 分页风险 ${index}`,
      createdByAccountId: actor.accountId,
      createdByPersonId: actor.personId,
      createdByName: "UI 分页用户",
      createdAt: collaborationTimestamp,
      updatedAt: collaborationTimestamp,
    })),
  });
  await prisma.domainAuditEvent.createMany({
    data: activityIds.map((id, index) => ({
      id,
      actorAccountId: actor.accountId,
      actorPersonId: actor.personId,
      action: "pm.project.metadata.update",
      entityType: "Project",
      entityId: project.id,
      projectId: project.id,
      before: { name: "旧名称" },
      after: { name: `UI 分页动态 ${index}` },
      createdAt: collaborationTimestamp,
    })),
  });
  await page.goto(`/progress/projects/${project.id}?section=collaboration`);
  await expect(page.getByText("UI 分页风险 0", { exact: true })).toBeVisible();
  await expect(page.getByText("UI 分页风险 20", { exact: true })).toHaveCount(0);
  await prisma.riskRecord.update({
    where: { id: riskIds[19]! },
    data: {
      status: "RESOLVED",
      resolvedByAccountId: actor.accountId,
      resolvedByPersonId: actor.personId,
      resolvedByName: "UI 分页用户",
      resolveNote: "模拟游标锚点状态变化",
      resolvedAt: new Date("2099-08-29T11:00:01.000Z"),
    },
  });
  await page
    .getByRole("button", { name: "加载更多未解决风险" })
    .first()
    .click();
  await expect(
    page.getByRole("status").getByText("风险列表已变化，已重新加载。"),
  ).toBeVisible();
  await expect(page.getByText("UI 分页风险 20", { exact: true })).toBeVisible();
  await page.getByTestId("project-activity-view").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("project-activity-view")).toBeVisible();
  await expect(page.getByText("UI 分页动态 20", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "加载更早动态" }).click();
  await expect(page.getByText("UI 分页动态 20", { exact: false })).toBeVisible();
  await expectHealthyPage(page);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

function cursorIdFromHref(href: string) {
  const cursor = new URL(href, "http://localhost").searchParams.get("cursor");
  if (!cursor) throw new Error("测试链接缺少 cursor");
  const decoded: unknown = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  if (
    !decoded ||
    typeof decoded !== "object" ||
    !("id" in decoded) ||
    typeof decoded.id !== "string"
  ) {
    throw new Error("测试链接 cursor 缺少 ID");
  }
  return decoded.id;
}
