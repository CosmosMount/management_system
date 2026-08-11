import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "../lib/prisma";
import {
  runMilestoneDeadlineScan,
  runProjectManagementIntegrityScan,
  runProjectManagementNotificationRetention,
} from "../lib/project-management/application/maintenance-service";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForAccountIdsTx,
  recipientsForPersonIdsTx,
} from "../lib/project-management/application/notification-utils";
import { updateNotificationPreference } from "../lib/project-management/application/notification-preference-service";
import { toProjectManagementServiceError } from "../lib/project-management/application/errors";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import { getActionInbox } from "../lib/project-management/queries/action-inbox-queries";
import { getMyWorkDashboard } from "../lib/project-management/queries/dashboard-queries";
import {
  getPersonalDueSegments,
  getTimeCanvasData,
} from "../lib/project-management/queries/time-canvas-queries";

test.describe("project management S8 dashboard and notifications", () => {
  test("Action Inbox filters by permission and sorts overdue work first", async () => {
    const user = await createActor("S8 Inbox");
    const other = await createActor("S8 Other");
    const now = new Date();
    const own = await prisma.workSegment.create({
      data: {
        personId: user.personId,
        type: "PLANNED",
        status: "PENDING_CONFIRMATION",
        startAt: new Date(now.getTime() - 2 * 60 * 60_000),
        endAt: new Date(now.getTime() - 60 * 60_000),
        content: `S8 待确认 ${randomUUID()}`,
        createdByAccountId: user.accountId,
      },
    });
    const hidden = await prisma.workSegment.create({
      data: {
        personId: other.personId,
        type: "PLANNED",
        status: "PENDING_CONFIRMATION",
        startAt: new Date(now.getTime() - 2 * 60 * 60_000),
        endAt: new Date(now.getTime() - 60 * 60_000),
        content: `S8 隐藏待确认 ${randomUUID()}`,
        createdByAccountId: other.accountId,
      },
    });
    const inbox = await getActionInbox({ actor: user, limit: 100 });
    expect(inbox.items).toContainEqual(
      expect.objectContaining({
        id: `segment-confirm:${own.id}`,
        kind: "SEGMENT_CONFIRMATION",
        severity: "HIGH",
        href: `/progress?focus=${own.id}`,
      }),
    );
    expect(inbox.items.some((item) => item.id.includes(hidden.id))).toBe(false);
    expect(inbox.criticalCount).toBe(0);
  });

  test("personal due queue paginates without gaps and excludes removed Task members", async () => {
    const user = await createActor("S8 Due pagination");
    const now = new Date("2030-08-11T08:00:00.000Z");
    const dueSegments = [];
    for (const offsetHours of [6, 4, 2]) {
      dueSegments.push(await prisma.workSegment.create({
        data: {
          personId: user.personId,
          type: "PLANNED",
          status: "PENDING_CONFIRMATION",
          startAt: new Date(now.getTime() - (offsetHours + 1) * 60 * 60_000),
          endAt: new Date(now.getTime() - offsetHours * 60 * 60_000),
          content: `S8 分页待确认 ${offsetHours}`,
          createdByAccountId: user.accountId,
        },
      }));
    }
    const task = await createActiveTaskWithMilestone(
      user,
      new Date("2030-09-01T08:00:00.000Z"),
    );
    const removedTaskSegment = await prisma.workSegment.create({
      data: {
        personId: user.personId,
        taskId: task.taskId,
        type: "PLANNED",
        status: "PENDING_CONFIRMATION",
        startAt: new Date(now.getTime() - 9 * 60 * 60_000),
        endAt: new Date(now.getTime() - 8 * 60 * 60_000),
        content: "S8 已移出 Task 的待确认",
        createdByAccountId: user.accountId,
      },
    });
    await prisma.taskMember.updateMany({
      where: { taskId: task.taskId, personId: user.personId, removedAt: null },
      data: { removedAt: new Date(now.getTime() - 30_000) },
    });

    const firstPage = await getPersonalDueSegments({
      actor: user,
      input: { limit: 2 },
      now,
    });
    expect(firstPage.items.map((item) => item.id)).toEqual([
      dueSegments[0]!.id,
      dueSegments[1]!.id,
    ]);
    expect(firstPage.items.some((item) => item.id === removedTaskSegment.id)).toBe(false);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.nextCursor).not.toContain(dueSegments[1]!.id);

    await prisma.workSegment.update({
      where: { id: dueSegments[1]!.id },
      data: { status: "CONFIRMED" },
    });

    const secondPage = await getPersonalDueSegments({
      actor: user,
      input: { cursor: firstPage.nextCursor, limit: 2 },
      now,
    });
    expect(secondPage.items.map((item) => item.id)).toEqual([dueSegments[2]!.id]);
    expect(secondPage.nextCursor).toBeNull();

    const other = await createActor("S8 Due cursor other");
    for (const invalidCursor of ["malformed", firstPage.nextCursor]) {
      const targetActor = invalidCursor === "malformed" ? user : other;
      await expect(
        getPersonalDueSegments({
          actor: targetActor,
          input: { cursor: invalidCursor, limit: 2 },
          now,
        }).catch((error) => toProjectManagementServiceError(error).code),
      ).resolves.toBe("VALIDATION_ERROR");
    }
  });

  test("Task approval gate hides Terminal inbox work and disables Canvas actions until release", async () => {
    const owner = await createActor("S8 Task approval gate");
    const task = await createActiveTaskWithMilestone(
      owner,
      new Date("2026-09-10T02:00:00.000Z"),
    );
    const terminationNodeId = randomUUID();
    const terminationId = randomUUID();
    await prisma.taskNode.create({
      data: {
        id: terminationNodeId,
        taskId: task.taskId,
        type: "TERMINATION",
        status: "PENDING",
        createdByAccountId: owner.accountId,
        planVersionEntries: {
          create: { planVersionId: task.planId, sequence: 2 },
        },
        termination: {
          create: {
            id: terminationId,
            name: "S8 Gate Terminal",
            plannedAt: new Date("2026-09-20T02:00:00.000Z"),
            plannedOutcomeCriteria: "审批空闲时允许结束",
          },
        },
      },
    });
    const canvasInput = {
      scope: { kind: "TASK_SCOPED" as const, taskId: task.taskId },
      rangeStart: "2026-09-01T00:00:00.000Z",
      rangeEnd: "2026-10-01T00:00:00.000Z",
      groupBy: "TASK" as const,
      includeTaskAnchors: true,
      includeActual: true,
      includeBusyBlocks: false,
    };
    const loadCapabilities = async () => {
      const canvas = await getTimeCanvasData({ actor: owner, input: canvasInput });
      const taskAnchor = canvas.anchors.find((anchor) => anchor.id === task.taskId);
      const milestoneAnchor = taskAnchor?.nodes.find(
        (node) => node.id === task.nodeId,
      );
      const terminationAnchor = taskAnchor?.nodes.find(
        (node) => node.id === terminationNodeId,
      );
      return {
        canCreateRevision: taskAnchor?.capabilities.canCreateRevision,
        canSubmitReview: milestoneAnchor?.capabilities.canSubmitReview,
        canConfirmTermination:
          terminationAnchor?.capabilities.canConfirmTermination,
      };
    };
    const terminalInboxId = `termination:${terminationId}`;

    await expect(loadCapabilities()).resolves.toEqual({
      canCreateRevision: true,
      canSubmitReview: true,
      canConfirmTermination: true,
    });
    expect(
      (await getActionInbox({ actor: owner, limit: 100 })).items.some(
        (item) => item.id === terminalInboxId,
      ),
    ).toBe(true);

    const review = await prisma.milestoneReview.create({
      data: {
        milestoneNodeId: task.milestoneId,
        result: "PENDING",
        submittedByAccountId: owner.accountId,
        idempotencyKey: `s8-task-approval-gate-${randomUUID()}`,
      },
      select: { id: true },
    });
    await expect(loadCapabilities()).resolves.toEqual({
      canCreateRevision: false,
      canSubmitReview: false,
      canConfirmTermination: false,
    });
    expect(
      (await getActionInbox({ actor: owner, limit: 100 })).items.some(
        (item) => item.id === terminalInboxId,
      ),
    ).toBe(false);

    await prisma.milestoneReview.update({
      where: { id: review.id },
      data: {
        revokedAt: new Date("2026-09-11T00:00:00.000Z"),
        revokeReason: "验证门禁释放",
      },
    });
    await expect(loadCapabilities()).resolves.toEqual({
      canCreateRevision: true,
      canSubmitReview: true,
      canConfirmTermination: true,
    });
    expect(
      (await getActionInbox({ actor: owner, limit: 100 })).items.some(
        (item) => item.id === terminalInboxId,
      ),
    ).toBe(true);
  });

  test("dashboard metrics are independent from display limits", async () => {
    const user = await createActor("S8 Dashboard totals");
    for (let index = 0; index < 13; index += 1) {
      await createActiveTaskWithMilestone(
        user,
        new Date(`2026-10-${String(index + 1).padStart(2, "0")}T02:00:00.000Z`),
      );
    }
    await prisma.workSegment.createMany({
      data: Array.from({ length: 21 }, (_, index) => ({
        personId: user.personId,
        type: "PLANNED" as const,
        status: "PENDING_CONFIRMATION" as const,
        startAt: new Date(2026, 8, 1, index),
        endAt: new Date(2026, 8, 1, index + 1),
        content: `S8 dashboard pending ${index}`,
        createdByAccountId: user.accountId,
      })),
    });

    const [dashboard, inbox] = await Promise.all([
      getMyWorkDashboard({ actor: user }),
      getActionInbox({ actor: user, limit: 20 }),
    ]);
    expect(dashboard.activeTasks).toHaveLength(12);
    expect(dashboard.activeTaskCount).toBe(13);
    expect(inbox.items).toHaveLength(20);
    expect(inbox.totalCount).toBe(21);
  });

  test("ordinary Feishu preference is honored while in-app and mandatory delivery remain", async () => {
    const user = await createActor("S8 Preference");
    await updateNotificationPreference(user, {
      category: "TASK",
      feishuEnabled: false,
    });
    const recipient = { accountId: user.accountId, openId: user.openId };
    const ordinaryKey = `s8-pref-ordinary-${randomUUID()}`;
    await prisma.$transaction((tx) =>
      createProjectManagementEventNotificationsTx(tx, {
        actor: user,
        kind: "task_assigned",
        category: "TASK",
        eventKey: ordinaryKey,
        title: "普通 Task 通知",
        summary: "普通飞书通知已关闭",
        entityType: "Task",
        entityId: randomUUID(),
        mandatory: false,
        recipients: [recipient],
      }),
    );
    expect(
      await prisma.inAppNotification.count({
        where: { eventKey: `${ordinaryKey}:inapp:${user.accountId}` },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationOutbox.count({ where: { eventKey: `${ordinaryKey}:feishu` } }),
    ).toBe(0);

    const mandatoryKey = `s8-pref-mandatory-${randomUUID()}`;
    await prisma.$transaction((tx) =>
      createProjectManagementEventNotificationsTx(tx, {
        actor: user,
        kind: "task_activated",
        category: "TASK",
        eventKey: mandatoryKey,
        title: "强制 Task 通知",
        summary: "关键状态变化仍保留",
        entityType: "Task",
        entityId: randomUUID(),
        mandatory: true,
        recipients: [recipient],
      }),
    );
    const mandatory = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey: `${mandatoryKey}:feishu` },
    });
    expect(mandatory.botKind).toBe("notification");
    expect(JSON.parse(mandatory.payload)).toMatchObject({
      mandatory: true,
      recipientOpenIds: [user.openId],
    });
  });

  test("notification recipient lookup uses the first non-empty default-tenant identity", async () => {
    const user = await createActor("S8 Recipient identity");
    await prisma.accountIdentity.updateMany({
      where: {
        accountId: user.accountId,
        provider: "FEISHU",
        tenantId: "default",
      },
      data: {
        openId: null,
        unionId: `on_s8_union_${randomUUID()}`,
      },
    });
    const laterValidOpenId = `ou_s8_later_${randomUUID()}`;
    await prisma.accountIdentity.create({
      data: {
        accountId: user.accountId,
        provider: "FEISHU",
        tenantId: "default",
        providerSubject: `open:${laterValidOpenId}`,
        openId: `  ${laterValidOpenId}  `,
      },
    });

    const [byAccount, byPerson] = await prisma.$transaction((tx) =>
      Promise.all([
        recipientsForAccountIdsTx(tx, [user.accountId]),
        recipientsForPersonIdsTx(tx, [user.personId]),
      ]),
    );
    expect(byAccount).toEqual([
      { accountId: user.accountId, openId: laterValidOpenId },
    ]);
    expect(byPerson).toEqual([
      { accountId: user.accountId, openId: laterValidOpenId },
    ]);
  });

  test("Shanghai milestone scanner is idempotent and maintenance is bounded", async () => {
    const user = await createActor("S8 Cron");
    const dueAt = new Date("2026-08-10T02:00:00.000Z");
    const fixture = await createActiveTaskWithMilestone(user, dueAt);
    const scanAt = new Date("2026-08-10T00:30:00.000Z");
    const first = await runMilestoneDeadlineScan(scanAt);
    const second = await runMilestoneDeadlineScan(scanAt);
    expect(first.localDate).toBe("2026-08-10");
    expect(second.localDate).toBe("2026-08-10");
    const eventKey = `pm:milestone:${fixture.milestoneId}:milestone_due:2026-08-10`;
    expect(
      await prisma.notificationOutbox.count({ where: { eventKey: `${eventKey}:feishu` } }),
    ).toBe(1);
    expect(
      await prisma.inAppNotification.count({
        where: { eventKey: `${eventKey}:inapp:${user.accountId}` },
      }),
    ).toBe(1);
    expect(
      await prisma.inAppNotification.findUnique({
        where: { eventKey: `${eventKey}:inapp:${user.accountId}` },
        select: { linkPath: true },
      }),
    ).toEqual({ linkPath: `/progress/tasks/${fixture.taskId}?tab=reviews` });

    const old = new Date("2025-01-01T00:00:00.000Z");
    const oldInApp = await prisma.inAppNotification.create({
      data: {
        recipientAccountId: user.accountId,
        category: "TASK",
        title: "S8 过期已读通知",
        entityType: "Task",
        entityId: randomUUID(),
        readAt: old,
        createdAt: old,
      },
    });
    const oldOutbox = await prisma.notificationOutbox.create({
      data: {
        eventKey: `s8-old-outbox-${randomUUID()}`,
        channel: "project-management",
        type: "task_assigned",
        payload: "{}",
        status: "SENT",
        sentAt: old,
        createdAt: old,
        updatedAt: old,
      },
    });
    const retention = await runProjectManagementNotificationRetention(
      new Date("2026-08-10T00:30:00.000Z"),
      5_000,
    );
    expect(retention.deletedInAppCount).toBeGreaterThanOrEqual(1);
    expect(retention.deletedOutboxCount).toBeGreaterThanOrEqual(1);
    expect(await prisma.inAppNotification.findUnique({ where: { id: oldInApp.id } })).toBeNull();
    expect(await prisma.notificationOutbox.findUnique({ where: { id: oldOutbox.id } })).toBeNull();
    expect((await runProjectManagementIntegrityScan()).violationCount).toBe(0);
  });

  test("deadline scanner and Action Inbox ignore nodes outside the Current Plan", async () => {
    const user = await createActor("S8 Current Plan Boundary");
    const now = new Date("2026-08-10T00:30:00.000Z");
    const current = await createActiveTaskWithMilestone(
      user,
      new Date("2026-08-10T02:00:00.000Z"),
    );
    const secondCurrent = await createActiveTaskWithMilestone(
      user,
      new Date("2026-08-10T03:00:00.000Z"),
    );
    const candidatePlanId = randomUUID();
    const candidateMilestoneNodeId = randomUUID();
    const candidateMilestoneId = randomUUID();
    const candidateTerminationNodeId = randomUUID();
    const candidateTerminationId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.taskPlanVersion.create({
        data: {
          id: candidatePlanId,
          taskId: current.taskId,
          versionNo: 2,
          status: "DRAFT",
          plannedStartAt: new Date("2026-08-01T00:00:00.000Z"),
          createdByAccountId: user.accountId,
        },
      });
      await tx.taskNode.create({
        data: {
          id: candidateMilestoneNodeId,
          taskId: current.taskId,
          type: "MILESTONE",
          status: "PENDING",
          createdByAccountId: user.accountId,
          planVersionEntries: {
            create: { planVersionId: candidatePlanId, sequence: 1 },
          },
          milestone: {
            create: {
              id: candidateMilestoneId,
              goal: "不得扫描的候选 Milestone",
              completionCriteria: "候选计划不产生 deadline 通知",
              expectedCompletedAt: new Date("2026-08-09T02:00:00.000Z"),
              reviewRequirements: "无",
            },
          },
        },
      });
      await tx.taskNode.create({
        data: {
          id: candidateTerminationNodeId,
          taskId: current.taskId,
          type: "TERMINATION",
          status: "PENDING",
          createdByAccountId: user.accountId,
          planVersionEntries: {
            create: { planVersionId: candidatePlanId, sequence: 2 },
          },
          termination: {
            create: {
              id: candidateTerminationId,
              name: "Terminal",
              plannedAt: new Date("2026-08-09T03:00:00.000Z"),
              plannedOutcomeCriteria: "候选计划 Termination 不得成为待办",
            },
          },
        },
      });
    });

    const pagedScan = await runMilestoneDeadlineScan(now, 1);
    expect(pagedScan.scannedCount).toBeGreaterThanOrEqual(2);
    for (const milestoneId of [current.milestoneId, secondCurrent.milestoneId]) {
      expect(
        await prisma.notificationOutbox.count({
          where: { eventKey: { startsWith: `pm:milestone:${milestoneId}:` } },
        }),
      ).toBe(1);
    }
    expect(
      await prisma.notificationOutbox.count({
        where: { eventKey: { startsWith: `pm:milestone:${candidateMilestoneId}:` } },
      }),
    ).toBe(0);
    expect(
      await prisma.inAppNotification.count({
        where: { entityType: "MilestoneNode", entityId: candidateMilestoneId },
      }),
    ).toBe(0);
    await prisma.taskPlanVersion.update({
      where: { id: candidatePlanId },
      data: { status: "ABANDONED" },
    });
    await runMilestoneDeadlineScan(now, 1);
    expect(
      await prisma.notificationOutbox.count({
        where: { eventKey: { startsWith: `pm:milestone:${candidateMilestoneId}:` } },
      }),
    ).toBe(0);

    const inbox = await getActionInbox({ actor: user, limit: 200 });
    expect(inbox.items.some((item) => item.id === `termination:${candidateTerminationId}`)).toBe(
      false,
    );
  });
});

async function createActor(displayName: string): Promise<ProjectManagementActor> {
  const openId = `ou_s8_${randomUUID()}`;
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
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("S8 test actor missing person");
  return {
    accountId: account.id,
    personId: account.person.id,
    openId,
    unionId: null,
    systemRoles: [],
  };
}

async function createActiveTaskWithMilestone(
  actor: ProjectManagementActor,
  dueAt: Date,
) {
  const taskId = randomUUID();
  const planId = randomUUID();
  const nodeId = randomUUID();
  const milestoneId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.task.create({
      data: {
        id: taskId,
        title: `S8 Task ${randomUUID()}`,
        team: "英雄",
        techGroup: "电控",
        status: "ACTIVE",
        currentPlanVersionId: planId,
        createdByAccountId: actor.accountId,
      },
    });
    await tx.taskPlanVersion.create({
      data: {
        id: planId,
        taskId,
        versionNo: 1,
        status: "CURRENT",
        plannedStartAt: new Date(dueAt.getTime() - 7 * 24 * 60 * 60_000),
        createdByAccountId: actor.accountId,
      },
    });
    await tx.taskMember.create({
      data: { taskId, personId: actor.personId, role: "OWNER", createdByAccountId: actor.accountId },
    });
    await tx.taskNode.create({
      data: {
        id: nodeId,
        taskId,
        type: "MILESTONE",
        status: "ACTIVE",
        createdByAccountId: actor.accountId,
        milestone: {
          create: {
            id: milestoneId,
            goal: "S8 截止提醒",
            completionCriteria: "提醒幂等",
            expectedCompletedAt: dueAt,
            reviewRequirements: "检查 outbox",
          },
        },
      },
    });
    await tx.planVersionNode.create({
      data: { planVersionId: planId, nodeId, sequence: 1 },
    });
    await tx.task.update({
      where: { id: taskId },
      data: { activeMilestoneNodeId: nodeId },
    });
  });
  return { taskId, planId, nodeId, milestoneId };
}
