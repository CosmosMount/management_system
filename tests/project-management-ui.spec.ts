import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  createTaskDraft,
} from "../lib/project-management/application/lifecycle-service";
import {
  createWorkSegment,
} from "../lib/project-management/application/segment-service";
import {
  scanConflictsForPerson,
} from "../lib/project-management/application/conflict-service";
import {
  markInAppNotificationRead as markInAppNotificationReadService,
} from "../lib/project-management/application/notification-service";
import {
  isoToShanghaiDateTimeLocal,
  shanghaiDateTimeLocalToIso,
} from "../lib/project-management/date-time";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import {
  expectHealthyPage,
  loginAsTestUser,
} from "./helpers/functional-fixtures";

test.describe("project management P4/P6 UI integration", () => {
  test("datetime-local helpers preserve Shanghai business wall-clock", () => {
    expect(shanghaiDateTimeLocalToIso("2026-08-10T00:00")).toBe(
      "2026-08-09T16:00:00.000Z",
    );
    expect(shanghaiDateTimeLocalToIso("2026-08-10T00:00:30.123")).toBe(
      "2026-08-09T16:00:30.123Z",
    );
    expect(isoToShanghaiDateTimeLocal("2026-08-09T16:00:00.000Z")).toBe(
      "2026-08-10T00:00",
    );
  });

  test("dashboard, Task workbench, resource timeline, conflicts and notifications work", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createUiFixture();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.member.openId,
      name: fixture.member.person.displayName,
    });

    await page.goto("/progress");
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeVisible();
    await expect(page.getByText(fixture.taskTitle)).toBeVisible();
    await expect(page.getByText("未读通知")).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/progress/tasks?mine=1");
    await expect(page.getByRole("heading", { name: "全部 Task" })).toBeVisible();
    await expect(page.getByText(fixture.taskTitle)).toBeVisible();
    await expectHealthyPage(page);

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(page.getByRole("heading", { name: fixture.taskTitle })).toBeVisible();
    await expect(page.getByRole("heading", { name: "当前计划" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "人员投入" })).toBeVisible();
    await expectHealthyPage(page);

    await page.goto(
      `/progress/resources?start=2026-08-10&end=2026-08-12&personId=${fixture.member.person.id}`,
    );
    await expect(page.getByRole("heading", { name: "人员计划" })).toBeVisible();
    await expect(page.getByText("P6 UI 可确认计划")).toBeVisible();
    await page.getByRole("button", { name: "与计划一致" }).first().click();
    await expect(page.getByText("已按计划生成 Actual")).toBeVisible();
    await expect
      .poll(async () => {
        const row = await prisma.workSegment.findUniqueOrThrow({
          where: { id: fixture.confirmableSegmentId },
          select: { status: true },
        });
        return row.status;
      })
      .toBe("CONFIRMED");
    await expectHealthyPage(page);

    await page.goto("/progress/resources/conflicts");
    await expect(page.getByRole("heading", { name: "资源冲突" })).toBeVisible();
    await expect(page.getByText("投入超过 100%").first()).toBeVisible();
    await page.getByRole("button", { name: "确认已知" }).click();
    await expect(page.getByText("已确认知晓该冲突")).toBeVisible();
    await expect
      .poll(async () => {
        const row = await prisma.resourceConflict.findUniqueOrThrow({
          where: { id: fixture.conflictId },
          select: { status: true },
        });
        return row.status;
      })
      .toBe("ACKNOWLEDGED");
    await expectHealthyPage(page);

    await page.goto("/progress/notifications");
    await expect(page.getByRole("heading", { name: "站内通知" })).toBeVisible();
    await expect(page.getByText("P6 UI 通知")).toBeVisible();
    await page
      .locator("article")
      .filter({ hasText: "P6 UI 通知" })
      .getByRole("button", { name: "标记已读" })
      .click();
    await expect(page.getByText("已标记通知为已读")).toBeVisible();
    await expect
      .poll(async () => {
        const row = await prisma.inAppNotification.findUniqueOrThrow({
          where: { id: fixture.notificationId },
          select: { readAt: true },
        });
        return row.readAt !== null;
      })
      .toBe(true);
    await expectHealthyPage(page);
  });

  test("non-member cannot enumerate Task workbench", async ({
    context,
    page,
    baseURL,
  }) => {
    const fixture = await createUiFixture();
    await loginAsTestUser(context, baseURL, {
      openId: fixture.outsider.openId,
      name: fixture.outsider.person.displayName,
    });

    await page.goto(`/progress/tasks/${fixture.taskId}`);
    await expect(
      page.getByRole("heading", { name: "页面不存在或无权访问" }),
    ).toBeVisible();
    await expectHealthyPage(page);

    await page.goto("/progress/notifications");
    await expect(page.getByRole("heading", { name: "站内通知" })).toBeVisible();
    await expect(page.getByText("P6 UI 通知")).toHaveCount(0);
    await expect(
      markInAppNotificationReadService(actor(fixture.outsider), {
        notificationId: fixture.notificationId,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

async function createUiFixture() {
  const admin = await createAccountPerson("P6 UI Team Admin");
  const owner = await createAccountPerson("P6 UI Owner");
  const member = await createAccountPerson("P6 UI Member");
  const reviewer = await createAccountPerson("P6 UI Reviewer");
  const outsider = await createAccountPerson("P6 UI Outsider");
  await grantRole(admin.account.id, "TEAM_ADMINISTRATOR", {
    team: "英雄",
    techGroup: "电控",
  });
  const taskTitle = `P6 UI Task ${randomUUID()}`;
  const draft = await createTaskDraft(actor(admin), {
    title: taskTitle,
    description: "P6 UI 集成测试 Task",
    team: "英雄",
    techGroup: "电控",
    priority: "HIGH",
    tagIds: [],
    members: [
      { personId: owner.person.id, role: "OWNER" },
      { personId: member.person.id, role: "MEMBER" },
      { personId: reviewer.person.id, role: "REVIEWER" },
    ],
    milestones: [
      milestoneInput("P6 UI 第一阶段", "完成第一阶段", 1),
      milestoneInput("P6 UI 第二阶段", "完成第二阶段", 2),
    ],
    plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
    termination: terminationInput(5),
    idempotencyKey: `p6-ui-task-${randomUUID()}`,
  });
  const activated = await activateTask(actor(owner), {
    taskId: draft.taskId,
    expectedLockVersion: draft.lockVersion,
  });
  const activeNode = await prisma.planVersionNode.findFirstOrThrow({
    where: {
      planVersionId: activated.currentPlanVersionId,
      node: { type: "MILESTONE", status: "ACTIVE" },
    },
    select: { nodeId: true },
  });
  const confirmable = await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(9),
    endAt: atHour(10),
    content: "P6 UI 可确认计划",
    allocation: 40,
    role: "DEVELOPER",
    priority: "MEDIUM",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(10),
    endAt: atHour(11),
    content: "P6 UI 冲突计划 A",
    allocation: 80,
    role: "DEVELOPER",
    priority: "MEDIUM",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  await createWorkSegment(actor(member), {
    personId: member.person.id,
    type: "PLANNED",
    startAt: atHour(10.5),
    endAt: atHour(11.5),
    content: "P6 UI 冲突计划 B",
    allocation: 50,
    role: "DEVELOPER",
    priority: "MEDIUM",
    taskId: draft.taskId,
    nodeId: activeNode.nodeId,
    tagIds: [],
  });
  await scanConflictsForPerson({
    personId: member.person.id,
    startAt: atHour(8),
    endAt: atHour(12),
  });
  const conflict = await prisma.resourceConflict.findFirstOrThrow({
    where: {
      personId: member.person.id,
      kind: "ALLOCATION_OVER_LIMIT",
      status: "OPEN",
    },
  });
  const notification = await prisma.inAppNotification.create({
    data: {
      eventKey: `p6-ui-notification-${randomUUID()}`,
      recipientAccountId: member.account.id,
      category: "TASK",
      title: "P6 UI 通知",
      summary: "这是一条用于验证通知中心的站内通知",
      entityType: "Task",
      entityId: draft.taskId,
      taskId: draft.taskId,
      linkPath: `/progress/tasks/${draft.taskId}`,
      payloadVersion: 1,
      payload: {},
    },
  });
  return {
    admin,
    owner,
    member,
    reviewer,
    outsider,
    taskId: draft.taskId,
    taskTitle,
    confirmableSegmentId: confirmable.segment.id,
    conflictId: conflict.id,
    notificationId: notification.id,
  };
}

async function createAccountPerson(displayName: string) {
  const openId = `ou_pm_p6_ui_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      status: "ACTIVE",
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: {
        create: {
          displayName,
          status: "ACTIVE",
        },
      },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { account, person: account.person, openId };
}

async function grantRole(
  accountId: string,
  role: "TEAM_ADMINISTRATOR",
  scope: { team: string; techGroup: string },
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team: scope.team,
      techGroup: scope.techGroup,
    },
  });
}

function actor(input: Awaited<ReturnType<typeof createAccountPerson>>): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles: [],
  };
}

function milestoneInput(goal: string, criteria: string, daysFromBase: number) {
  return {
    goal,
    completionCriteria: criteria,
    expectedCompletedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    reviewRequirements: "提交文本或链接证据",
    businessDescription: goal,
  };
}

function terminationInput(daysFromBase: number) {
  return {
    plannedOutcomeCriteria: "所有 Milestone 完成并完成总结",
    plannedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    businessDescription: "结束确认",
  };
}

function atHour(hour: number) {
  const fullHour = Math.trunc(hour);
  const minutes = Math.round((hour - fullHour) * 60);
  return new Date(Date.UTC(2026, 7, 10, fullHour, minutes, 0));
}
