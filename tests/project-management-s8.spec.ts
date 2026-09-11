// @playwright-project node-db
import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  actionInboxLoadRecovery,
  appendActionInboxPage,
} from "../components/project-management/action-inbox-state";
import { prisma } from "../lib/prisma";
import { expectedProjectManagementRecipients } from "./helpers/project-management-notification-recipients";
import type { ProjectManagementActionFailure } from "../lib/project-management/application/action-result";
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
import type { ProjectManagementNotificationPayload } from "../lib/project-management/notifications/contract";
import {
  getActionInbox,
  type ActionInboxItem,
  type ActionInboxPage,
} from "../lib/project-management/queries/action-inbox-queries";
import { getMyWorkDashboard } from "../lib/project-management/queries/dashboard-queries";
import { listWorkSegments } from "../lib/project-management/queries/resource-queries";
import { getTimeCanvasData } from "../lib/project-management/queries/time-canvas-queries";

test.describe("project management S8 dashboard and notifications", () => {
  test.beforeAll(async () => {
    const approvalAdmin = await createActor("S8 全局审批管理员");
    await prisma.systemRoleAssignment.create({
      data: {
        accountId: approvalAdmin.accountId,
        role: "PROJECT_ADMINISTRATOR",
      },
    });
  });

  test("elapsed own and other people's records never become Action Inbox items", async () => {
    const user = await createActor("S8 Inbox");
    const other = await createActor("S8 Other");
    const now = new Date();
    const own = await prisma.workSegment.create({
      data: {
        personId: user.personId,
        startAt: new Date(now.getTime() - 2 * 60 * 60_000),
        endAt: new Date(now.getTime() - 60 * 60_000),
        content: `S8 已结束普通投入 ${randomUUID()}`,
        createdByAccountId: user.accountId,
      },
    });
    const hidden = await prisma.workSegment.create({
      data: {
        personId: other.personId,
        startAt: new Date(now.getTime() - 2 * 60 * 60_000),
        endAt: new Date(now.getTime() - 60 * 60_000),
        content: `S8 其他人员已结束投入 ${randomUUID()}`,
        createdByAccountId: other.accountId,
      },
    });
    const inbox = await getActionInbox({ actor: user, input: { limit: 100 } });
    expect(inbox.items.some((item) => item.id.includes(own.id))).toBe(false);
    expect(inbox.items.some((item) => item.id.includes(hidden.id))).toBe(false);
    expect(inbox.criticalCount).toBe(0);
  });

  test("Action Inbox assigns next-node severity from a stable generated time", async () => {
    const user = await createActor("S8 Inbox next-node severity");
    const now = new Date("2030-08-10T08:00:00.000Z");
    const overdue = await createActiveTaskWithMilestone(
      user,
      new Date("2030-08-10T07:00:00.000Z"),
    );
    const future = await createActiveTaskWithMilestone(
      user,
      new Date("2030-08-10T09:00:00.000Z"),
    );

    const inbox = await getActionInbox({
      actor: user,
      input: { limit: 100 },
      now,
    });
    expect(inbox.totalCount).toBe(2);
    expect(inbox.criticalCount).toBe(1);
    expect(inbox.items).toEqual([
      expect.objectContaining({
        id: `task-next-node:${overdue.nodeId}`,
        kind: "TASK_NEXT_NODE",
        severity: "CRITICAL",
        nodeType: "MILESTONE",
        nodeStatus: "ACTIVE",
      }),
      expect.objectContaining({
        id: `task-next-node:${future.nodeId}`,
        kind: "TASK_NEXT_NODE",
        severity: "MEDIUM",
      }),
    ]);
  });

  test("Action Inbox next nodes require an active effective Task membership", async () => {
    const member = await createActor("S8 Inbox member boundary");
    const outsider = await createActor("S8 Inbox outsider boundary");
    const administrator = await createActor("S8 Inbox administrator boundary");
    const task = await createActiveTaskWithMilestone(
      member,
      new Date("2030-09-01T08:00:00.000Z"),
    );
    const itemId = `task-next-node:${task.nodeId}`;
    const administratorActor: ProjectManagementActor = {
      ...administrator,
      systemRoles: [{ role: "PROJECT_ADMINISTRATOR", team: "", techGroup: "" }],
    };

    expect(
      (
        await getActionInbox({ actor: member, input: { limit: 100 } })
      ).items.some((item) => item.id === itemId),
    ).toBe(true);
    for (const actorUnderTest of [outsider, administratorActor]) {
      expect(
        (
          await getActionInbox({
            actor: actorUnderTest,
            input: { limit: 100 },
          })
        ).items.some((item) => item.id === itemId),
      ).toBe(false);
    }

    const inactiveInbox = await getActionInbox({
      actor: { ...member, isActive: false },
      input: { limit: 100 },
    });
    expect(inactiveInbox).toMatchObject({
      items: [],
      totalCount: 0,
      criticalCount: 0,
      nextCursor: null,
    });

    await prisma.task.update({
      where: { id: task.taskId },
      data: { status: "DRAFT" },
    });
    expect(
      (
        await getActionInbox({ actor: member, input: { limit: 100 } })
      ).items.some((item) => item.id === itemId),
    ).toBe(false);
    await prisma.task.update({
      where: { id: task.taskId },
      data: { status: "COMPLETED" },
    });
    expect(
      (
        await getActionInbox({ actor: member, input: { limit: 100 } })
      ).items.some((item) => item.id === itemId),
    ).toBe(false);
    await prisma.task.update({
      where: { id: task.taskId },
      data: { status: "ACTIVE", deletedAt: new Date() },
    });
    expect(
      (
        await getActionInbox({ actor: member, input: { limit: 100 } })
      ).items.some((item) => item.id === itemId),
    ).toBe(false);
    await prisma.$transaction([
      prisma.task.update({
        where: { id: task.taskId },
        data: { status: "ACTIVE", deletedAt: null },
      }),
      prisma.taskMember.updateMany({
        where: {
          taskId: task.taskId,
          personId: member.personId,
          removedAt: null,
        },
        data: { removedAt: new Date() },
      }),
    ]);
    expect(
      (
        await getActionInbox({ actor: member, input: { limit: 100 } })
      ).items.some((item) => item.id === itemId),
    ).toBe(false);
  });

  test("Action Inbox cursor merges streams without gaps and rejects invalid ownership", async () => {
    const user = await createActor("S8 Inbox cursor");
    const other = await createActor("S8 Inbox cursor other");
    const now = new Date("2030-10-01T08:00:00.000Z");
    const expectedIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const task = await createActiveTaskWithMilestone(
        user,
        new Date(now.getTime() + (index + 1) * 60 * 60_000),
      );
      expectedIds.push(`task-next-node:${task.nodeId}`);
    }
    const segment = await prisma.workSegment.create({
      data: {
        personId: user.personId,
        startAt: new Date(now.getTime() - 2 * 60 * 60_000),
        endAt: new Date(now.getTime() - 60 * 60_000),
        content: "S8 Inbox cursor segment",
        createdByAccountId: user.accountId,
      },
    });

    const loadedIds: string[] = [];
    const generatedTimes = new Set<string>();
    let cursor: string | undefined;
    let firstCursor: string | null = null;
    do {
      const page = await getActionInbox({
        actor: user,
        input: { ...(cursor ? { cursor } : {}), limit: 2 },
        now: cursor ? new Date(now.getTime() + 24 * 60 * 60_000) : now,
      });
      generatedTimes.add(page.generatedAt);
      loadedIds.push(...page.items.map((item) => item.id));
      if (!firstCursor) firstCursor = page.nextCursor;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(loadedIds).toEqual(expectedIds);
    expect(loadedIds).not.toContain(`segment-confirm:${segment.id}`);
    expect(new Set(loadedIds).size).toBe(loadedIds.length);
    expect(generatedTimes).toEqual(new Set([now.toISOString()]));
    if (!firstCursor) throw new Error("Action Inbox 测试缺少分页游标");
    const decoded = JSON.parse(
      Buffer.from(firstCursor, "base64url").toString("utf8"),
    ) as { core: { generatedAt: string }; signature: string };
    decoded.core.generatedAt = "2031-01-01T00:00:00.000Z";
    decoded.signature = createHash("sha256")
      .update("action-inbox-cursor:v1\n")
      .update(JSON.stringify(decoded.core))
      .digest("base64url")
      .slice(0, 22);
    const tampered = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    await prisma.workSegment.update({
      where: { id: segment.id },
      data: { content: "普通投入编辑不会生成待办" },
    });
    const unchangedQueue = await getActionInbox({
      actor: user,
      input: { cursor: firstCursor, limit: 2 },
    });
    expect(unchangedQueue.items.map((item) => item.id)).toEqual(expectedIds.slice(2, 4));
    await prisma.milestoneNode.update({
      where: { nodeId: expectedIds[1].replace("task-next-node:", "") },
      data: { expectedCompletedAt: new Date(now.getTime() + 10 * 60 * 60_000) },
    });
    const expectedCursorFailure = {
      code: "VALIDATION_ERROR",
      message: "分页游标无效或已不再匹配当前待办队列",
      fieldErrors: {
        cursor: ["分页游标无效或已不再匹配当前待办队列"],
      },
    } satisfies ProjectManagementActionFailure["error"];
    expect(actionInboxLoadRecovery("APPEND", expectedCursorFailure)).toBe(
      "RELOAD_QUEUE",
    );
    expect(
      actionInboxLoadRecovery("APPEND", {
        code: "VALIDATION_ERROR",
        message: "分页大小不正确",
        fieldErrors: { limit: ["分页大小不正确"] },
      }),
    ).toBe("RETRY_CURSOR");
    expect(
      actionInboxLoadRecovery("APPEND", {
        code: "INTERNAL_ERROR",
        message: "操作失败，请稍后重试",
        fieldErrors: { cursor: ["不应被识别为游标失效"] },
      }),
    ).toBe("RETRY_CURSOR");
    const retainedItem = actionInboxSnapshotItem("snapshot-retained");
    const appendedItem = actionInboxSnapshotItem("snapshot-appended");
    const currentSnapshot = {
      items: [retainedItem],
      totalCount: 55,
      criticalCount: 7,
      nextCursor: "old-cursor",
      generatedAt: "2030-10-01T08:00:00.000Z",
    } satisfies ActionInboxPage;
    const incomingSnapshot = {
      items: [retainedItem, appendedItem],
      totalCount: 54,
      criticalCount: 3,
      nextCursor: "next-cursor",
      generatedAt: "2030-10-02T08:00:00.000Z",
    } satisfies ActionInboxPage;
    expect(appendActionInboxPage(currentSnapshot, incomingSnapshot)).toEqual({
      ...currentSnapshot,
      items: [retainedItem, appendedItem],
      nextCursor: incomingSnapshot.nextCursor,
    });
    expect(
      actionInboxLoadRecovery("APPEND", {
        code: "VALIDATION_ERROR",
        message: "分页游标格式不正确",
        fieldErrors: { cursor: [] },
      }),
    ).toBe("RETRY_CURSOR");
    await expect(
      actionInboxFailure(
        getActionInbox({
          actor: user,
          input: { cursor: firstCursor, limit: 2 },
        }),
      ),
    ).resolves.toEqual(expectedCursorFailure);
    for (const [targetActor, invalidCursor] of [
      [user, "malformed"],
      [user, tampered],
      [other, firstCursor],
    ] as const) {
      await expect(
        actionInboxFailure(
          getActionInbox({
            actor: targetActor,
            input: { cursor: invalidCursor, limit: 2 },
          }),
        ),
      ).resolves.toEqual(expectedCursorFailure);
    }
    await expect(
      actionInboxFailure(
        getActionInbox({
          actor: user,
          input: { limit: 2, unexpected: true },
        }),
      ),
    ).resolves.toEqual({
      code: "VALIDATION_ERROR",
      message: "输入内容不符合要求",
      fieldErrors: { _form: ["请求包含不支持的字段"] },
    });
  });

  test("Action Inbox paginates equal-priority streams in global stable order", async () => {
    const administrator = await createActor("S8 Inbox mixed streams");
    const actor: ProjectManagementActor = {
      ...administrator,
      systemRoles: [
        { role: "PROJECT_ADMINISTRATOR", team: "", techGroup: "" },
      ],
    };
    const relevantAt = new Date("1900-01-01T08:00:00.000Z");
    const now = new Date("1900-01-02T08:00:00.000Z");
    const segment = await prisma.workSegment.create({
      data: {
        personId: actor.personId,
        startAt: new Date("1900-01-01T07:00:00.000Z"),
        endAt: relevantAt,
        content: "S8 混合流投入确认",
        createdByAccountId: actor.accountId,
      },
    });
    const taskId = randomUUID();
    const planId = randomUUID();
    const revisionNodeId = randomUUID();
    const revisionId = randomUUID();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
      await tx.task.create({
        data: {
          id: taskId,
          title: "S8 混合流 Revision",
          status: "DRAFT",
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
          createdByAccountId: actor.accountId,
        },
      });
      await tx.taskNode.create({
        data: {
          id: revisionNodeId,
          taskId,
          type: "REVISION",
          status: "ACTIVE",
          createdByAccountId: actor.accountId,
          revision: {
            create: {
              id: revisionId,
              reason: "验证全局混合流分页",
              revisionAt: relevantAt,
              basePlanVersionId: planId,
            },
          },
        },
      });
    });
    const projectRequestId = randomUUID();
    await prisma.project.create({
      data: {
        name: "S8 混合流立项",
        description: "验证相同优先级和时间的跨流稳定排序",
        status: "PENDING_APPROVAL",
        requesterAccountId: actor.accountId,
        submittedAt: relevantAt,
        establishmentRequests: {
          create: {
            id: projectRequestId,
            round: 1,
            idempotencyKey: randomUUID(),
            requestHash: "s8-mixed-streams",
            submittedByAccountId: actor.accountId,
            submittedAt: relevantAt,
            snapshot: {},
          },
        },
      },
    });

    const expectedIds = [
      `project-establishment:${projectRequestId}`,
      `revision:${revisionId}`,
    ];
    const loadedIds: string[] = [];
    const generatedTimes = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < expectedIds.length; pageIndex += 1) {
      const page = await test.step(
        `加载跨流第 ${pageIndex + 1} 页`,
        () =>
          getActionInbox({
            actor,
            input: { ...(cursor ? { cursor } : {}), limit: 1 },
            now,
          }),
      );
      loadedIds.push(...page.items.map((item) => item.id));
      generatedTimes.add(page.generatedAt);
      cursor = page.nextCursor ?? undefined;
    }

    expect(loadedIds).toEqual(expectedIds);
    expect(loadedIds).not.toContain(`segment-confirm:${segment.id}`);
    expect(new Set(loadedIds).size).toBe(loadedIds.length);
    expect(generatedTimes).toEqual(new Set([now.toISOString()]));
  });

  test("ordinary record pagination excludes deleted records and preserves person filters", async () => {
    const user = await createActor("S8 Record pagination");
    const other = await createActor("S8 Record other person");
    const now = new Date("2030-08-11T08:00:00.000Z");
    const records = [];
    for (const offsetHours of [6, 4, 2]) {
      records.push(await prisma.workSegment.create({
        data: {
          personId: user.personId,
          startAt: new Date(now.getTime() - (offsetHours + 1) * 60 * 60_000),
          endAt: new Date(now.getTime() - offsetHours * 60 * 60_000),
          content: `S8 普通分页记录 ${offsetHours}`,
          createdByAccountId: user.accountId,
        },
      }));
    }
    const otherRecord = await prisma.workSegment.create({
      data: {
        personId: other.personId,
        startAt: records[0]!.startAt,
        endAt: records[0]!.endAt,
        content: "其他人员记录不应混入筛选",
        createdByAccountId: other.accountId,
      },
    });
    const firstPage = await listWorkSegments({
      actor: user,
      input: { personId: user.personId, limit: 2 },
    });
    expect(firstPage.items.map((item) => item.id)).toEqual(records.slice(0, 2).map((record) => record.id));
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await listWorkSegments({
      actor: user,
      input: { personId: user.personId, cursor: firstPage.nextCursor, limit: 2 },
    });
    expect(secondPage.items.map((item) => item.id)).toEqual([records[2]!.id]);
    expect(secondPage.nextCursor).toBeNull();
    expect([...firstPage.items, ...secondPage.items].map((item) => item.id)).not.toContain(otherRecord.id);
    await prisma.workSegment.update({
      where: { id: records[1]!.id },
      data: { deletedAt: now },
    });
    const afterDelete = await listWorkSegments({
      actor: user,
      input: { personId: user.personId, limit: 2 },
    });
    expect(afterDelete.items.map((item) => item.id)).toEqual([records[0]!.id, records[2]!.id]);
    expect(afterDelete.nextCursor).toBeNull();
    const inbox = await getActionInbox({ actor: user, input: { limit: 100 }, now });
    expect(inbox.items).toEqual([]);
  });

  test("Action Inbox shows only the active Task node and suppresses an overlapping review", async () => {
    const owner = await createActor("S8 Task approval gate");
    const approvalAdmin = await createActor("S8 Terminal capability admin");
    await prisma.systemRoleAssignment.create({
      data: {
        accountId: approvalAdmin.accountId,
        role: "PROJECT_ADMINISTRATOR",
      },
    });
    const approvalAdminActor: ProjectManagementActor = {
      ...approvalAdmin,
      systemRoles: [{ role: "PROJECT_ADMINISTRATOR", team: "", techGroup: "" }],
    };
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
            name: "Terminal",
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
      includeBusyBlocks: false,
    };
    const loadCapabilities = async (canvasActor = owner) => {
      const canvas = await getTimeCanvasData({
        actor: canvasActor,
        input: canvasInput,
      });
      const taskAnchor = canvas.anchors.find(
        (anchor) => anchor.id === task.taskId,
      );
      const milestoneAnchor = taskAnchor?.nodes.find(
        (node) => node.id === task.nodeId,
      );
      const terminationAnchor = taskAnchor?.nodes.find(
        (node) => node.id === terminationNodeId,
      );
      return {
        canCreateRevision: taskAnchor?.capabilities.canCreateRevision,
        canSubmitReview: milestoneAnchor?.capabilities.canSubmitReview,
        canSubmitTerminationReview:
          terminationAnchor?.capabilities.canSubmitTerminationReview,
        canReviewTermination: terminationAnchor?.capabilities.canReview,
      };
    };
    const milestoneInboxId = `task-next-node:${task.nodeId}`;
    const terminalInboxId = `task-next-node:${terminationNodeId}`;

    const revisionNodeId = randomUUID();
    await prisma.taskNode.create({
      data: {
        id: revisionNodeId,
        taskId: task.taskId,
        type: "REVISION",
        status: "ACTIVE",
        createdByAccountId: owner.accountId,
        revision: {
          create: {
            reason: "验证 Revision 不抑制当前节点",
            revisionAt: new Date("2026-09-12T02:00:00.000Z"),
            basePlanVersionId: task.planId,
          },
        },
      },
    });

    expect(
      (
        await getActionInbox({ actor: owner, input: { limit: 100 } })
      ).items.find((item) => item.id === milestoneInboxId),
    ).toEqual(
      expect.objectContaining({
        kind: "TASK_NEXT_NODE",
        nodeType: "MILESTONE",
      }),
    );
    expect(
      (
        await getActionInbox({ actor: owner, input: { limit: 100 } })
      ).items.some((item) => item.id === terminalInboxId),
    ).toBe(false);
    expect(
      (
        await getActionInbox({ actor: owner, input: { limit: 100 } })
      ).items.some((item) => item.id === milestoneInboxId),
    ).toBe(true);
    expect(
      (
        await getActionInbox({
          actor: approvalAdminActor,
          input: { limit: 100 },
        })
      ).items,
    ).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^revision:/),
        nodeId: revisionNodeId,
      }),
    );
    expect(
      (
        await getActionInbox({
          actor: approvalAdminActor,
          input: { limit: 100 },
        })
      ).items.some((item) => item.id === milestoneInboxId),
    ).toBe(false);
    await prisma.$transaction([
      prisma.revisionNode.update({
        where: { nodeId: revisionNodeId },
        data: { status: "CANCELLED" },
      }),
      prisma.taskNode.update({
        where: { id: revisionNodeId },
        data: { status: "CANCELLED" },
      }),
    ]);
    await expect(loadCapabilities()).resolves.toEqual({
      canCreateRevision: true,
      canSubmitReview: true,
      canSubmitTerminationReview: true,
      canReviewTermination: false,
    });

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
      canSubmitTerminationReview: false,
      canReviewTermination: false,
    });
    expect(
      (
        await getActionInbox({ actor: owner, input: { limit: 100 } })
      ).items.some((item) => item.id === milestoneInboxId),
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
      canSubmitTerminationReview: true,
      canReviewTermination: false,
    });
    expect(
      (
        await getActionInbox({ actor: owner, input: { limit: 100 } })
      ).items.some((item) => item.id === milestoneInboxId),
    ).toBe(true);

    await prisma.$transaction([
      prisma.taskNode.update({
        where: { id: task.nodeId },
        data: { status: "COMPLETED" },
      }),
      prisma.taskNode.update({
        where: { id: terminationNodeId },
        data: { status: "ACTIVE" },
      }),
      prisma.task.update({
        where: { id: task.taskId },
        data: { activeMilestoneNodeId: null },
      }),
    ]);
    expect(
      (
        await getActionInbox({ actor: owner, input: { limit: 100 } })
      ).items.find((item) => item.id === terminalInboxId),
    ).toEqual(
      expect.objectContaining({
        kind: "TASK_NEXT_NODE",
        nodeType: "TERMINATION",
        summary: "计划结束标准：审批空闲时允许结束",
      }),
    );

    const terminationReview = await prisma.terminationReview.create({
      data: {
        terminationNodeId: terminationId,
        outcome: "CANCELLED",
        reason: "验证 Canvas Terminal 审批 capability",
        summary: "管理员应看到审批能力",
        submittedByAccountId: owner.accountId,
        idempotencyKey: `s8-termination-capability-${randomUUID()}`,
      },
      select: { id: true },
    });
    await expect(loadCapabilities()).resolves.toEqual({
      canCreateRevision: false,
      canSubmitReview: false,
      canSubmitTerminationReview: false,
      canReviewTermination: false,
    });
    await expect(loadCapabilities(approvalAdminActor)).resolves.toEqual({
      canCreateRevision: false,
      canSubmitReview: false,
      canSubmitTerminationReview: false,
      canReviewTermination: true,
    });
    expect(
      (
        await getActionInbox({ actor: owner, input: { limit: 100 } })
      ).items.some((item) => item.id === terminalInboxId),
    ).toBe(false);
    expect(
      (
        await getActionInbox({
          actor: approvalAdminActor,
          input: { limit: 100 },
        })
      ).items.some((item) => item.id === terminalInboxId),
    ).toBe(false);

    await prisma.terminationReview.update({
      where: { id: terminationReview.id },
      data: {
        result: "REJECTED",
        reviewedAt: new Date(),
        reviewerAccountId: approvalAdmin.accountId,
        comment: "结束 capability 验证",
      },
    });
    expect(
      (
        await getActionInbox({ actor: owner, input: { limit: 100 } })
      ).items.some((item) => item.id === terminalInboxId),
    ).toBe(true);
    await prisma.task.update({
      where: { id: task.taskId },
      data: { status: "DRAFT" },
    });
    expect(
      (
        await getActionInbox({ actor: owner, input: { limit: 100 } })
      ).items.some((item) => item.id === terminalInboxId),
    ).toBe(false);
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
        startAt: new Date(2026, 8, 1, index),
        endAt: new Date(2026, 8, 1, index + 1),
        content: `S8 dashboard pending ${index}`,
        createdByAccountId: user.accountId,
      })),
    });

    const [dashboard, inbox] = await Promise.all([
      getMyWorkDashboard({ actor: user }),
      getActionInbox({ actor: user, input: { limit: 20 } }),
    ]);
    expect(dashboard.activeTasks).toHaveLength(12);
    expect(dashboard.activeTaskCount).toBe(13);
    expect(inbox.items).toHaveLength(13);
    expect(inbox.totalCount).toBe(13);
    expect(dashboard).not.toHaveProperty("pendingConfirmations");
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
    const expectedOrdinaryRecipients = await expectedProjectManagementRecipients(
      [{ account: { id: user.accountId }, openId: user.openId }], "TASK",
    );
    const ordinaryOutbox = await prisma.notificationOutbox.findUnique({ where: { eventKey: `${ordinaryKey}:feishu` } });
    expect(ordinaryOutbox !== null).toBe(expectedOrdinaryRecipients.openIds.length > 0);
    const ordinaryOpenIds = ordinaryOutbox ? (JSON.parse(ordinaryOutbox.payload) as ProjectManagementNotificationPayload).recipientOpenIds : [];
    expect(ordinaryOpenIds.slice().sort()).toEqual(expectedOrdinaryRecipients.openIds);
    expect(ordinaryOpenIds).not.toContain(user.openId);

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
    });
    expect((JSON.parse(mandatory.payload) as ProjectManagementNotificationPayload).recipientOpenIds.slice().sort()).toEqual(
      (await expectedProjectManagementRecipients([{ account: { id: user.accountId }, openId: user.openId }], "TASK", true)).openIds,
    );

    await prisma.person.update({
      where: { id: user.personId },
      data: { status: "INACTIVE" },
    });
    await expect(
      updateNotificationPreference(user, {
        category: "TASK",
        feishuEnabled: true,
      }).catch((error) => {
        throw toProjectManagementServiceError(error);
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "人员已停用，无法执行此操作",
    });
    await expect(
      prisma.notificationPreference.findUniqueOrThrow({
        where: {
          accountId_category_channel: {
            accountId: user.accountId,
            category: "TASK",
            channel: "FEISHU",
          },
        },
        select: { enabled: true },
      }),
    ).resolves.toEqual({ enabled: false });
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
    ).toEqual({ linkPath: `/progress/tasks/${fixture.taskId}` });

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

    await prisma.$transaction([
      prisma.taskNode.update({
        where: { id: candidateTerminationNodeId },
        data: { status: "ACTIVE" },
      }),
      prisma.task.update({
        where: { id: current.taskId },
        data: { activeMilestoneNodeId: null },
      }),
    ]);

    const inbox = await getActionInbox({ actor: user, input: { limit: 100 } });
    expect(
      inbox.items.some((item) => item.id === `task-next-node:${candidateTerminationNodeId}`),
    ).toBe(false);
    expect(inbox.items.map((item) => item.kind)).not.toContain("TERMINATION");
  });
});

function actionInboxFailure(operation: Promise<unknown>) {
  return operation.then(
    () => {
      throw new Error("Action Inbox 错误测试预期查询失败");
    },
    (error: unknown) => {
      const mapped = toProjectManagementServiceError(error);
      return {
        code: mapped.code,
        message: mapped.message,
        fieldErrors: mapped.fieldErrors,
      };
    },
  );
}

function actionInboxSnapshotItem(id: string): ActionInboxItem {
  return {
    currentNodeDeadline: null,
    id,
    kind: "TASK_NEXT_NODE",
    title: id,
    summary: "快照合并测试",
    projectId: null,
    projectName: null,
    taskId: null,
    taskTitle: null,
    nodeId: null,
    nodeType: null,
    nodeStatus: null,
    relevantAt: "2030-10-01T08:00:00.000Z",
    timeLabel: "预计完成",
    severity: "HIGH",
    href: `/progress?focus=${id}`,
    actionLabel: "查看节点",
  };
}

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
