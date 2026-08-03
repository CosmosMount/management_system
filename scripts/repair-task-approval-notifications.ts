import "dotenv/config";
import { Prisma } from "@prisma/client";
import { logger, withScriptLogging } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { createProjectManagementEventNotificationsTx } from "@/lib/project-management/application/notification-utils";

const scriptArgs = process.argv.slice(2);
const APPLY = scriptArgs.includes("--apply");
const FROZEN_NEXT_RUN_AT = new Date("9999-12-31T00:00:00.000Z");
const FROZEN_ATTEMPTS = 8;
const FREEZE_REASON =
  "Task 审批收件人规则已迁移到全局管理员；旧 Reviewer/组长审批 outbox 已冻结。";

type Recipient = { accountId: string; openId: string | null };

async function main() {
  return withScriptLogging("repair-task-approval-notifications", async () => {
    const unsupportedArgs = scriptArgs.filter(
      (argument) => argument !== "--apply",
    );
    if (unsupportedArgs.length > 0) {
      throw new Error(`不支持的参数：${unsupportedArgs.join(", ")}`);
    }
    if (
      APPLY &&
      process.env.NOTIFICATION_DELIVERY_DISABLED?.trim().toLowerCase() !==
        "true"
    ) {
      throw new Error(
        "--apply 仅允许在 NOTIFICATION_DELIVERY_DISABLED=true 的通知禁发环境执行",
      );
    }
    const [pendingMilestones, pendingRevisions, recipients, legacyOutboxes] =
      await Promise.all([
        prisma.milestoneReview.findMany({
          where: { result: "PENDING", revokedAt: null },
          select: { id: true },
          orderBy: { id: "asc" },
        }),
        prisma.revisionNode.findMany({
          where: { status: "PENDING_APPROVAL" },
          select: { id: true },
          orderBy: { id: "asc" },
        }),
        globalAdministratorRecipients(),
        prisma.notificationOutbox.findMany({
          where: {
            status: { in: ["PENDING", "PROCESSING", "FAILED"] },
            OR: [
              { eventKey: { startsWith: "pm:milestone:review_submitted:" } },
              { eventKey: { startsWith: "pm:revision:pending_review:" } },
            ],
          },
          select: { id: true, eventKey: true },
        }),
      ]);
    const retryableLegacyOutboxIds = legacyOutboxes
      .filter((outbox) => isLegacyApprovalEventKey(outbox.eventKey))
      .map((outbox) => outbox.id);

    logger.info("task.approval_notification_repair.preflight", {
      module: "script",
      action: "repairTaskApprovalNotifications",
      apply: APPLY,
      pendingMilestoneCount: pendingMilestones.length,
      pendingRevisionCount: pendingRevisions.length,
      administratorRecipientCount: recipients.length,
      retryableLegacyOutboxCount: retryableLegacyOutboxIds.length,
    });
    if (!APPLY) return;
    if (recipients.length === 0) {
      throw new Error("没有可接收审批通知的活跃全局管理员，修复已阻断");
    }
    if (!recipients.some((recipient) => recipient.openId)) {
      throw new Error(
        "活跃全局管理员均缺少默认租户的有效飞书 openId，修复已阻断",
      );
    }

    for (const review of pendingMilestones) {
      await repairMilestone(review.id, recipients);
    }
    for (const revision of pendingRevisions) {
      await repairRevision(revision.id, recipients);
    }
    // Pending approvals freeze their exact legacy event and create the
    // replacement notification in one transaction. Only after every pending
    // object succeeds may retryable legacy events without a pending object be
    // frozen as stale requests.
    await prisma.notificationOutbox.updateMany({
      where: { id: { in: retryableLegacyOutboxIds } },
      data: {
        status: "FAILED",
        attempts: FROZEN_ATTEMPTS,
        lastError: FREEZE_REASON,
        nextRunAt: FROZEN_NEXT_RUN_AT,
        lockedUntil: null,
      },
    });
    logger.audit("task.approval_notification_repair.applied", {
      module: "script",
      action: "repairTaskApprovalNotifications",
      pendingMilestoneCount: pendingMilestones.length,
      pendingRevisionCount: pendingRevisions.length,
      administratorRecipientCount: recipients.length,
    });
  });
}

function isLegacyApprovalEventKey(eventKey: string) {
  return (
    /^pm:milestone:review_submitted:[0-9a-f-]+:feishu$/.test(eventKey) ||
    /^pm:revision:pending_review:[0-9a-f-]+:feishu$/.test(eventKey)
  );
}

async function globalAdministratorRecipients(): Promise<Recipient[]> {
  const assignments = await prisma.systemRoleAssignment.findMany({
    where: {
      role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] },
      team: "",
      techGroup: "",
      revokedAt: null,
    },
    select: {
      account: {
        select: {
          id: true,
          identities: {
            where: { provider: "FEISHU", tenantId: "default" },
            select: { id: true, openId: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });
  const byAccount = new Map<string, Recipient>();
  for (const assignment of assignments) {
    const openId =
      assignment.account.identities
        .map((identity) => identity.openId?.trim() ?? "")
        .find(Boolean) ?? null;
    byAccount.set(assignment.account.id, {
      accountId: assignment.account.id,
      openId,
    });
  }
  return [...byAccount.values()];
}

async function repairMilestone(reviewId: string, recipients: Recipient[]) {
  await prisma.$transaction(async (tx) => {
    const review = await tx.milestoneReview.findFirst({
      where: { id: reviewId, result: "PENDING", revokedAt: null },
      select: {
        id: true,
        milestoneNode: {
          select: {
            node: {
              select: {
                task: {
                  select: {
                    id: true,
                    title: true,
                    status: true,
                    currentPlanVersionId: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!review) return;
    await freezeLegacyOutboxTx(
      tx,
      `pm:milestone:review_submitted:${review.id}:feishu`,
    );
    const task = review.milestoneNode.node.task;
    await createProjectManagementEventNotificationsTx(tx, {
      actorName: "系统迁移",
      task,
      kind: "milestone_review_submitted",
      category: "REVIEW",
      eventKey: `pm:milestone:review_submitted:global-admin:v2:${review.id}`,
      title: "Milestone 待验收",
      summary: `Task「${task.title}」有 Milestone 待验收`,
      entityType: "MilestoneReview",
      entityId: review.id,
      mandatory: true,
      recipients,
      context: { recipientPolicy: "GLOBAL_ADMINISTRATORS_V2" },
    });
    await auditRepairTx(tx, "MilestoneReview", review.id, task.id);
  });
}

async function repairRevision(revisionId: string, recipients: Recipient[]) {
  await prisma.$transaction(async (tx) => {
    const revision = await tx.revisionNode.findFirst({
      where: { id: revisionId, status: "PENDING_APPROVAL" },
      select: {
        id: true,
        node: {
          select: {
            task: {
              select: {
                id: true,
                title: true,
                status: true,
                currentPlanVersionId: true,
              },
            },
          },
        },
      },
    });
    if (!revision) return;
    await freezeLegacyOutboxTx(
      tx,
      `pm:revision:pending_review:${revision.id}:feishu`,
    );
    const task = revision.node.task;
    await createProjectManagementEventNotificationsTx(tx, {
      actorName: "系统迁移",
      task,
      kind: "revision_pending_review",
      category: "REVISION",
      eventKey: `pm:revision:pending_review:global-admin:v2:${revision.id}`,
      title: "计划修订待审批",
      summary: `Task「${task.title}」有新的计划修订待审批`,
      entityType: "RevisionNode",
      entityId: revision.id,
      mandatory: true,
      recipients,
      context: { recipientPolicy: "GLOBAL_ADMINISTRATORS_V2" },
    });
    await auditRepairTx(tx, "RevisionNode", revision.id, task.id);
  });
}

async function freezeLegacyOutboxTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
) {
  await tx.notificationOutbox.updateMany({
    where: {
      eventKey,
      status: { in: ["PENDING", "PROCESSING", "FAILED"] },
    },
    data: {
      status: "FAILED",
      attempts: FROZEN_ATTEMPTS,
      lastError: FREEZE_REASON,
      nextRunAt: FROZEN_NEXT_RUN_AT,
      lockedUntil: null,
    },
  });
}

async function auditRepairTx(
  tx: Prisma.TransactionClient,
  entityType: "MilestoneReview" | "RevisionNode",
  entityId: string,
  taskId: string,
) {
  await tx.domainAuditEvent.createMany({
    data: [
      {
        id: `migration:task-approval-notification:v2:${entityType}:${entityId}`,
        action: "pm.approval.notification.repaired",
        entityType,
        entityId,
        taskId,
        after: {
          recipientPolicy: "GLOBAL_ADMINISTRATORS_V2",
          legacyRetryableOutboxFrozen: true,
        },
        reason: FREEZE_REASON,
        source: "MIGRATION",
      },
    ],
    skipDuplicates: true,
  });
}

main()
  .catch((error) => {
    logger.error("task.approval_notification_repair.failed", {
      module: "script",
      action: "repairTaskApprovalNotifications",
      error,
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
