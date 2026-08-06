import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  createRevision,
  createTaskDraft,
  submitMilestoneForReview,
} from "../lib/project-management/application/lifecycle-service";
import { toProjectManagementServiceError } from "../lib/project-management/application/errors";
import { createProjectManagementEventNotificationsTx } from "../lib/project-management/application/notification-utils";
import type { ProjectManagementActor } from "../lib/project-management/identity";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260805120000_single_task_pending_approval/migration.sql",
);

test("single Task approval migration withdraws pending Milestone and Revision without touching other domains", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname) ||
    !parsedDatabaseUrl.pathname.endsWith("_test")
  ) {
    throw new Error("单一审批迁移测试只允许使用 runner 持有的本机 _test 数据库");
  }

  const admin = await createAccountPerson("单一审批迁移 Admin");
  const owner = await createAccountPerson("单一审批迁移 Owner");
  await prisma.systemRoleAssignment.create({
    data: {
      accountId: admin.accountId,
      role: "PROJECT_ADMINISTRATOR",
      team: "",
      techGroup: "",
    },
  });
  const actor = projectActor(admin);
  const created = await createTaskDraft(actor, {
    title: `单一审批迁移 Task ${randomUUID()}`,
    description: "同时构造 Milestone 与 Revision 待审批",
    team: "英雄",
    techGroup: "电控",
    priority: "HIGH",
    tagIds: [],
    members: [{ personId: owner.personId, role: "OWNER" }],
    plannedStartAt: "2026-08-01T01:00:00.000Z",
    milestones: [
      {
        goal: "迁移 Milestone",
        completionCriteria: "验证统一撤出",
        expectedCompletedAt: "2026-08-03T01:00:00.000Z",
        reviewRequirements: "文本证据",
        businessDescription: "迁移验证",
      },
    ],
    termination: {
      name: "迁移 Terminal",
      plannedOutcomeCriteria: "迁移完成",
      plannedAt: "2026-08-10T01:00:00.000Z",
      businessDescription: "迁移结束",
    },
    idempotencyKey: `single-approval-migration-task-${randomUUID()}`,
  });
  const activated = await activateTask(actor, {
    taskId: created.taskId,
    expectedLockVersion: 0,
  });
  const revision = await createRevision(actor, {
    taskId: created.taskId,
    basePlanVersionId: created.currentPlanVersionId,
    baseTaskLockVersion: activated.lockVersion,
    reason: "迁移待审批 Revision",
    description: "迁移待审批 Revision",
    revisionAt: "2026-08-02T01:00:00.000Z",
    replacementMilestones: [
      {
        goal: "迁移候选 Milestone",
        completionCriteria: "候选节点应取消",
        expectedCompletedAt: "2026-08-05T01:00:00.000Z",
        reviewRequirements: "文本证据",
        businessDescription: "候选节点",
      },
    ],
    termination: {
      name: "迁移候选 Terminal",
      plannedOutcomeCriteria: "候选计划结束",
      plannedAt: "2026-08-12T01:00:00.000Z",
      businessDescription: "候选结束",
    },
    idempotencyKey: `single-approval-migration-revision-${randomUUID()}`,
  });
  const milestone = await prisma.milestoneNode.findFirstOrThrow({
    where: {
      node: {
        taskId: created.taskId,
        id: activated.activeMilestoneNodeId ?? "",
      },
    },
    select: { id: true, nodeId: true },
  });
  const historicalReview = await prisma.milestoneReview.create({
    data: {
      milestoneNodeId: milestone.id,
      result: "REJECTED",
      submittedByAccountId: admin.accountId,
      reviewerAccountId: admin.accountId,
      reviewedAt: new Date("2026-08-01T12:00:00.000Z"),
      comment: "历史终态不得改写",
      idempotencyKey: `single-approval-history-${randomUUID()}`,
    },
    select: { id: true, result: true, revokedAt: true },
  });
  const pendingReviewKey = `single-approval-pending-${randomUUID()}`;
  const pendingReview = await prisma.milestoneReview.create({
    data: {
      milestoneNodeId: milestone.id,
      result: "PENDING",
      submittedByAccountId: admin.accountId,
      idempotencyKey: pendingReviewKey,
    },
    select: { id: true },
  });
  await prisma.$transaction(async (tx) => {
    await createProjectManagementEventNotificationsTx(tx, {
      actor,
      task: {
        id: created.taskId,
        title: "单一审批迁移 Task",
        status: "ACTIVE",
        currentPlanVersionId: created.currentPlanVersionId,
      },
      kind: "milestone_review_submitted",
      category: "REVIEW",
      eventKey: `pm:milestone:review_submitted:${pendingReview.id}`,
      title: "Milestone 待验收",
      summary: "迁移前待审批",
      entityType: "MilestoneReview",
      entityId: pendingReview.id,
      mandatory: true,
      recipients: [{ accountId: admin.accountId, openId: admin.openId }],
    });
  });
  const milestoneOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
    where: {
      eventKey: `pm:milestone:review_submitted:${pendingReview.id}:feishu`,
    },
    select: { id: true },
  });
  const recipient = await prisma.notificationOutboxRecipient.create({
    data: {
      outboxId: milestoneOutbox.id,
      openId: admin.openId,
      status: "PENDING",
    },
    select: { id: true },
  });
  const revisionOutbox = await prisma.notificationOutbox.findUniqueOrThrow({
    where: {
      eventKey: `pm:revision:pending_review:${revision.revisionNodeId}:round:1:feishu`,
    },
    select: { id: true },
  });
  const revisionRecipient = await prisma.notificationOutboxRecipient.create({
    data: {
      outboxId: revisionOutbox.id,
      openId: admin.openId,
      status: "PROCESSING",
      lockedUntil: new Date("2026-08-05T10:00:00.000Z"),
    },
    select: { id: true },
  });
  const previousRevisionResult = await prisma.inAppNotification.create({
    data: {
      eventKey: `single-approval-previous-result-${revision.revisionNodeId}`,
      recipientAccountId: admin.accountId,
      category: "REVISION",
      title: "上一轮 Revision 已驳回",
      summary: "迁移不得把历史结果通知误标已读",
      entityType: "RevisionNode",
      entityId: revision.revisionNodeId,
      taskId: created.taskId,
      linkPath: `/progress/tasks/${created.taskId}?tab=revisions`,
      payload: {
        kind: "revision_result",
        entityId: revision.revisionNodeId,
      },
    },
    select: { id: true },
  });
  const beforeTask = await prisma.task.findUniqueOrThrow({
    where: { id: created.taskId },
    select: { currentPlanVersionId: true, lockVersion: true },
  });
  const beforeCurrentNodes = await prisma.planVersionNode.findMany({
    where: { planVersionId: created.currentPlanVersionId },
    orderBy: { sequence: "asc" },
    select: { nodeId: true, node: { select: { status: true } } },
  });
  const procurementCount = await prisma.purchaseOrder.count();

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(await readFile(migrationPath, "utf8"));
  } finally {
    await client.end();
  }

  await expect(
    prisma.milestoneReview.findUniqueOrThrow({
      where: { id: pendingReview.id },
      select: {
        result: true,
        revokedAt: true,
        revokedByAccountId: true,
        revokeReason: true,
      },
    }),
  ).resolves.toMatchObject({
    result: "PENDING",
    revokedAt: expect.any(Date),
    revokedByAccountId: null,
    revokeReason: expect.stringContaining("单一审批门禁"),
  });
  await expect(
    submitMilestoneForReview(actor, {
      milestoneNodeId: milestone.nodeId,
      idempotencyKey: pendingReviewKey,
      evidences: [{ kind: "TEXT", note: "撤出后的旧请求键不得伪装待审批" }],
    }).catch((error) => toProjectManagementServiceError(error)),
  ).resolves.toMatchObject({
    code: "STATE_CONFLICT",
    message: expect.stringContaining("已撤出"),
  });
  await expect(
    prisma.milestoneReview.findUniqueOrThrow({
      where: { id: historicalReview.id },
      select: { result: true, revokedAt: true },
    }),
  ).resolves.toEqual({ result: "REJECTED", revokedAt: null });
  await expect(
    prisma.revisionNode.findUniqueOrThrow({
      where: { id: revision.revisionNodeId },
      select: { status: true, reviewComment: true },
    }),
  ).resolves.toMatchObject({
    status: "CANCELLED",
    reviewComment: expect.stringContaining("单一审批门禁"),
  });
  await expect(
    prisma.taskPlanVersion.findUniqueOrThrow({
      where: { id: revision.targetPlanVersionId ?? "" },
      select: { status: true },
    }),
  ).resolves.toEqual({ status: "ABANDONED" });
  const candidateNodeStatuses = await prisma.planVersionNode.findMany({
    where: {
      planVersionId: revision.targetPlanVersionId ?? "",
      isCarryForward: false,
    },
    select: { node: { select: { status: true } } },
  });
  expect(candidateNodeStatuses.length).toBeGreaterThan(0);
  expect(candidateNodeStatuses.every((entry) => entry.node.status === "CANCELLED")).toBe(true);
  await expect(
    prisma.task.findUniqueOrThrow({
      where: { id: created.taskId },
      select: { currentPlanVersionId: true, lockVersion: true },
    }),
  ).resolves.toEqual(beforeTask);
  await expect(
    prisma.planVersionNode.findMany({
      where: { planVersionId: created.currentPlanVersionId },
      orderBy: { sequence: "asc" },
      select: { nodeId: true, node: { select: { status: true } } },
    }),
  ).resolves.toEqual(beforeCurrentNodes);
  await expect(
    prisma.notificationOutbox.findUniqueOrThrow({
      where: { id: milestoneOutbox.id },
      select: { status: true, attempts: true, lastError: true },
    }),
  ).resolves.toMatchObject({
    status: "FAILED",
    attempts: 8,
    lastError: expect.stringContaining("永久冻结"),
  });
  await expect(
    prisma.notificationOutboxRecipient.findUniqueOrThrow({
      where: { id: recipient.id },
      select: { status: true, attempts: true, lastError: true },
    }),
  ).resolves.toMatchObject({
    status: "FAILED",
    attempts: 8,
    lastError: expect.stringContaining("永久冻结"),
  });
  await expect(
    prisma.notificationOutbox.findUniqueOrThrow({
      where: { id: revisionOutbox.id },
      select: { status: true, attempts: true, lastError: true },
    }),
  ).resolves.toMatchObject({
    status: "FAILED",
    attempts: 8,
    lastError: expect.stringContaining("永久冻结"),
  });
  await expect(
    prisma.notificationOutboxRecipient.findUniqueOrThrow({
      where: { id: revisionRecipient.id },
      select: {
        status: true,
        attempts: true,
        lastError: true,
        lockedUntil: true,
      },
    }),
  ).resolves.toMatchObject({
    status: "FAILED",
    attempts: 8,
    lastError: expect.stringContaining("永久冻结"),
    lockedUntil: null,
  });
  expect(
    await prisma.inAppNotification.count({
      where: {
        entityId: { in: [pendingReview.id, revision.revisionNodeId] },
        readAt: null,
        OR: [
          { payload: { path: ["kind"], equals: "milestone_review_submitted" } },
          { payload: { path: ["kind"], equals: "revision_pending_review" } },
        ],
      },
    }),
  ).toBe(0);
  await expect(
    prisma.inAppNotification.findUniqueOrThrow({
      where: { id: previousRevisionResult.id },
      select: { readAt: true },
    }),
  ).resolves.toEqual({ readAt: null });
  expect(
    await prisma.domainAuditEvent.count({
      where: {
        id: {
          in: [
            `migration:single-task-approval:v1:MilestoneReview:${pendingReview.id}`,
            `migration:single-task-approval:v1:RevisionNode:${revision.revisionNodeId}`,
          ],
        },
        source: "MIGRATION",
      },
    }),
  ).toBe(2);
  expect(
    await prisma.milestoneReview.count({
      where: { result: "PENDING", revokedAt: null },
    }),
  ).toBe(0);
  expect(
    await prisma.revisionNode.count({ where: { status: "PENDING_APPROVAL" } }),
  ).toBe(0);
  expect(await prisma.purchaseOrder.count()).toBe(procurementCount);
});

async function createAccountPerson(displayName: string) {
  const openId = `ou_single_approval_${randomUUID()}`;
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
  if (!account.person) throw new Error("测试账号缺少 Person");
  return {
    accountId: account.id,
    personId: account.person.id,
    openId,
  };
}

function projectActor(account: {
  accountId: string;
  personId: string;
  openId: string;
}): ProjectManagementActor {
  return {
    accountId: account.accountId,
    personId: account.personId,
    openId: account.openId,
    systemRoles: [
      {
        role: "PROJECT_ADMINISTRATOR",
        team: "",
        techGroup: "",
      },
    ],
  };
}
