import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { activateTask, createTaskDraft } from "../../lib/project-management/application/lifecycle-service";
import { createWorkSegment } from "../../lib/project-management/application/segment-service";
import type { ProjectManagementActor } from "../../lib/project-management/identity";

export async function createUiFixture() {
  const fixtureKey = randomUUID();
  const admin = await createAccountPerson(`P6 UI Team Admin ${fixtureKey}`);
  const owner = await createAccountPerson(`P6 UI Owner ${fixtureKey}`);
  const member = await createAccountPerson(`P6 UI Member ${fixtureKey}`);
  const reviewer = await createAccountPerson(`P6 UI Reviewer ${fixtureKey}`);
  const outsider = await createAccountPerson(`P6 UI Outsider ${fixtureKey}`);
  const inactiveHistory = await createAccountPerson(
    `P6 UI Historical Person ${fixtureKey}`,
  );
  await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
  const taskTitle = `P6 UI Task ${randomUUID()}`;
  const draft = await createTaskDraft(actor(admin), {
    title: taskTitle,
    description: "P6 UI 集成测试 Task",
    team: "英雄",
    techGroup: "电控",
    priority: "HIGH",
    members: [
      { personId: owner.person.id, role: "OWNER" },
      { personId: member.person.id, role: "PARTICIPANT" },
      { personId: reviewer.person.id, role: "PARTICIPANT" },
      { personId: inactiveHistory.person.id, role: "PARTICIPANT" },
    ],
    milestones: [
      milestoneInput("P6 UI 第一阶段", "完成第一阶段", 1),
      milestoneInput("P6 UI 第二阶段", "完成第二阶段", 2),
    ],
    plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
    termination: terminationInput(5),
    idempotencyKey: `p6-ui-task-${randomUUID()}`,
  });
  await activateTask(actor(owner), {
    taskId: draft.taskId,
    expectedLockVersion: draft.lockVersion,
  });
  const activeTask = await prisma.task.findUniqueOrThrow({
    where: { id: draft.taskId },
    select: { activeMilestoneNodeId: true },
  });
  if (!activeTask.activeMilestoneNodeId) {
    throw new Error("P6 UI fixture 缺少 Active Milestone");
  }
  const confirmable = await createWorkSegment(actor(member), {
    personId: member.person.id,
    startAt: atHour(9),
    endAt: atHour(10),
    content: "P6 UI 可确认计划",
    taskId: draft.taskId,
  });
  const movable = await createWorkSegment(actor(member), {
    personId: member.person.id,
    startAt: atHour(10),
    endAt: atHour(11),
    content: "P6 UI 重叠计划 A",
    taskId: draft.taskId,
  });
  await createWorkSegment(actor(owner), {
    personId: owner.person.id,
    startAt: atHour(8),
    endAt: atHour(9),
    content: "P6 UI 跨行目标人员安排",
    taskId: draft.taskId,
  });
  await createWorkSegment(actor(member), {
    personId: member.person.id,
    startAt: atHour(10.5),
    endAt: atHour(11.5),
    content: "P6 UI 重叠计划 B",
    taskId: draft.taskId,
  });
  const inactiveHistorySegment = await createWorkSegment(
    actor(inactiveHistory),
    {
      personId: inactiveHistory.person.id,
      startAt: atHour(15),
      endAt: atHour(16),
      content: "P6 UI 停用人员历史投入",
      taskId: draft.taskId,
    },
  );
  await prisma.person.update({
    where: { id: inactiveHistory.person.id },
    data: { status: "INACTIVE" },
  });
  const batchCancelableA = await createWorkSegment(actor(member), {
    personId: member.person.id,
    startAt: atHour(12),
    endAt: atHour(13),
    content: "P6 UI 批量取消 A",
    taskId: draft.taskId,
  });
  const batchCancelableB = await createWorkSegment(actor(member), {
    personId: member.person.id,
    startAt: atHour(13),
    endAt: atHour(14),
    content: "P6 UI 批量取消 B",
    taskId: draft.taskId,
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
    inactiveHistory,
    taskId: draft.taskId,
    taskTitle,
    activeNodeId: activeTask.activeMilestoneNodeId,
    confirmableSegmentId: confirmable.segment.id,
    movableSegmentId: movable.segment.id,
    inactiveHistorySegmentId: inactiveHistorySegment.segment.id,
    batchCancelableSegmentIds: [
      batchCancelableA.segment.id,
      batchCancelableB.segment.id,
    ] as const,
    brushCreateContent: `P6 UI 画布拖选创建 ${randomUUID()}`,
    notificationId: notification.id,
  };
}

export async function createLargeTaskWorkbenchFixture() {
  const fixtureKey = randomUUID();
  const owner = await createAccountPerson("超".repeat(256));
  const taskTitle = "任".repeat(200);
  const finalMilestoneGoal = "里".repeat(2_000);
  const terminalName = "终".repeat(200);
  const task = await createTaskDraft(actor(owner), {
    title: taskTitle,
    description: "验证大量节点、超长 Task 和人员名称不会撑破三层详情页布局",
    team: "英雄",
    techGroup: "电控",
    priority: "HIGH",
    members: [{ personId: owner.person.id, role: "OWNER" }],
    milestones: Array.from({ length: 200 }, (_, index) =>
      milestoneInput(
        index === 199
          ? finalMilestoneGoal
          : `压力 Milestone ${String(index + 1).padStart(3, "0")}`,
        `完成压力 Milestone ${index + 1}`,
        index + 1,
      ),
    ),
    plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
    termination: { ...terminationInput(202), name: terminalName },
    idempotencyKey: `p6-large-workbench-${fixtureKey}`,
  });
  return {
    owner,
    taskId: task.taskId,
    taskTitle,
    finalMilestoneGoal,
    terminalName,
  };
}

export async function createDraftWorkbenchFixture() {
  const fixtureSuffix = randomUUID();
  const admin = await createAccountPerson(`S6 Draft Team Admin ${fixtureSuffix}`);
  const owner = await createAccountPerson(`S6 Draft Owner ${fixtureSuffix}`);
  const reviewer = await createAccountPerson(`S6 Draft Reviewer ${fixtureSuffix}`);
  const taskTitle = `S6 Draft Workbench ${randomUUID()}`;
  const task = await createTaskDraft(actor(admin), {
    title: taskTitle,
    description: "S6 Draft 工作台测试",
    team: "英雄",
    techGroup: "电控",
    priority: "MEDIUM",
    members: [
      { personId: owner.person.id, role: "OWNER" },
      { personId: reviewer.person.id, role: "PARTICIPANT" },
    ],
    milestones: [
      milestoneInput("S6 Draft 第一阶段", "完成第一阶段", 1),
      milestoneInput("S6 Draft 第二阶段", "完成第二阶段", 2),
    ],
    plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
    termination: terminationInput(5),
    idempotencyKey: `s6-draft-workbench-${randomUUID()}`,
  });
  return { admin, owner, reviewer, taskId: task.taskId, taskTitle };
}

export async function createAccountPerson(displayName: string) {
  const openId = `ou_pm_p6_ui_${randomUUID()}`;
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

export async function grantRole(
  accountId: string,
  role: "PROJECT_ADMINISTRATOR",
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team: "",
      techGroup: "",
    },
  });
}

export function actor(input: Awaited<ReturnType<typeof createAccountPerson>>): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles: [],
  };
}

export function milestoneInput(goal: string, criteria: string, daysFromBase: number) {
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

export function terminationInput(daysFromBase: number) {
  return {
    name: "Terminal",
    plannedOutcomeCriteria: "所有 Milestone 完成并完成总结",
    plannedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    businessDescription: "结束确认",
  };
}

export function atHour(hour: number) {
  const fullHour = Math.trunc(hour);
  const minutes = Math.round((hour - fullHour) * 60);
  return new Date(Date.UTC(2026, 7, 10, fullHour, minutes, 0));
}
