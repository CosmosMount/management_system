import { Prisma, type WorkSegmentChangeAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForPersonIdsTx,
} from "@/lib/project-management/application/notification-utils";
import {
  segmentInclude,
  snapshotSegment,
  type SegmentForMutation,
} from "@/lib/project-management/application/segment-record";

type PrismaTx = Prisma.TransactionClient;

export async function scanSegmentTransitions(now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const toPending = await tx.workSegment.findMany({
      where: {
        type: "PLANNED",
        status: { in: ["PLANNED", "IN_PROGRESS"] },
        endAt: { lte: now },
        deletedAt: null,
      },
      include: segmentInclude,
      orderBy: { id: "asc" },
      take: 500,
    });
    const toInProgress = await tx.workSegment.findMany({
      where: {
        type: "PLANNED",
        status: "PLANNED",
        startAt: { lte: now },
        endAt: { gt: now },
        deletedAt: null,
      },
      include: segmentInclude,
      orderBy: { id: "asc" },
      take: 500,
    });
    let pendingConfirmationCount = 0;
    for (const segment of toPending) {
      const transition = await tx.workSegment.updateMany({
        where: {
          id: segment.id,
          type: "PLANNED",
          status: { in: ["PLANNED", "IN_PROGRESS"] },
          endAt: { lte: now },
          deletedAt: null,
          updatedAt: segment.updatedAt,
        },
        data: { status: "PENDING_CONFIRMATION" },
      });
      if (transition.count !== 1) continue;
      const before = snapshotSegment(segment);
      const updated = await loadSegmentForMutationTx(tx, segment.id);
      await recordSystemSegmentChangeTx(tx, {
        segmentId: updated.id,
        action: "UPDATE",
        before,
        after: snapshotSegment(updated),
        reason: "Planned Segment 已到期，等待确认",
      });
      await notifySegmentConfirmationDueTx(tx, updated);
      pendingConfirmationCount += 1;
    }

    let inProgressCount = 0;
    for (const segment of toInProgress) {
      const transition = await tx.workSegment.updateMany({
        where: {
          id: segment.id,
          type: "PLANNED",
          status: "PLANNED",
          startAt: { lte: now },
          endAt: { gt: now },
          deletedAt: null,
          updatedAt: segment.updatedAt,
        },
        data: { status: "IN_PROGRESS" },
      });
      if (transition.count !== 1) continue;
      const before = snapshotSegment(segment);
      const updated = await loadSegmentForMutationTx(tx, segment.id);
      await recordSystemSegmentChangeTx(tx, {
        segmentId: updated.id,
        action: "UPDATE",
        before,
        after: snapshotSegment(updated),
        reason: "Planned Segment 已开始",
      });
      inProgressCount += 1;
    }
    return { pendingConfirmationCount, inProgressCount };
  });
}

async function notifySegmentConfirmationDueTx(
  tx: PrismaTx,
  segment: SegmentForMutation,
) {
  const recipients = await recipientsForPersonIdsTx(tx, [segment.personId]);
  await createProjectManagementEventNotificationsTx(tx, {
    actorName: "系统",
    task: segment.task
      ? {
          id: segment.task.id,
          title: segment.task.title,
          status: segment.task.status,
          currentPlanVersionId: segment.task.currentPlanVersionId,
        }
      : null,
    kind: "segment_confirmation_due",
    category: "WORK_SEGMENT",
    eventKey: `pm:segment:confirmation_due:${segment.id}:${segment.endAt.toISOString()}`,
    title: "Planned Segment 待确认",
    summary: `计划投入「${segment.content}」已到结束时间，请确认实际投入`,
    entityType: "WorkSegment",
    entityId: segment.id,
    linkPath: `/progress?focus=${segment.id}`,
    mandatory: false,
    recipients,
    context: {
      segmentId: segment.id,
      segmentStatus: segment.status,
      endAt: segment.endAt.toISOString(),
    },
  });
}

async function loadSegmentForMutationTx(
  tx: PrismaTx,
  segmentId: string,
): Promise<SegmentForMutation> {
  return tx.workSegment.findUniqueOrThrow({
    where: { id: segmentId },
    include: segmentInclude,
  });
}

async function recordSystemSegmentChangeTx(
  tx: PrismaTx,
  input: {
    segmentId: string;
    action: WorkSegmentChangeAction;
    before: Prisma.InputJsonValue | null;
    after: Prisma.InputJsonValue | null;
    reason: string;
  },
) {
  await tx.workSegmentChange.create({
    data: {
      segmentId: input.segmentId,
      action: input.action,
      before: input.before ?? Prisma.JsonNull,
      after: input.after ?? Prisma.JsonNull,
      reason: input.reason,
      actorAccountId: null,
    },
  });
  await createDomainAuditEventTx(tx, {
    action: `pm.segment.${input.action.toLowerCase()}`,
    entityType: "WorkSegment",
    entityId: input.segmentId,
    taskId: extractTaskId(input.after) ?? extractTaskId(input.before),
    before: input.before,
    after: input.after,
    reason: input.reason,
    source: "CRON",
  });
}

function extractTaskId(value: Prisma.InputJsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const taskId = (value as Record<string, unknown>).taskId;
  return typeof taskId === "string" ? taskId : null;
}
