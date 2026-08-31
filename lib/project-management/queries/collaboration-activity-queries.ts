import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validationError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  actionsForActivityFilter,
  formatRecentActivityAuditEvent,
  RECENT_ACTIVITY_ACTIONS,
  type RecentActivityItemDto,
} from "@/lib/project-management/recent-activity-formatter";
import {
  cursorWhere,
  loadReadableTarget,
  toTimestampCursor,
  type TargetType,
  type TimestampCursor,
} from "@/lib/project-management/queries/collaboration-query-support";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "@/lib/project-management/queries/keyset-cursor";
import {
  activityVersionInputSchema,
  recentActivityPageInputSchema,
} from "@/lib/project-management/validations/collaboration";

export type RecentActivityPageDto = {
  items: RecentActivityItemDto[];
  nextCursor: string | null;
};

export async function getRecentActivityPage(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RecentActivityPageDto> {
  const parsed = recentActivityPageInputSchema.parse(input);
  await loadReadableTarget(actor, parsed.targetType, parsed.targetId);
  const cursorScope = JSON.stringify({
    targetType: parsed.targetType,
    targetId: parsed.targetId,
    category: parsed.category,
  });
  const cursor = toTimestampCursor(
    decodeKeysetCursor(
      parsed.cursor ?? undefined,
      "ACTIVITY",
      cursorScope,
      "动态分页游标无效",
    ),
  );
  const actionNames = actionsForActivityFilter(
    parsed.targetType,
    parsed.category,
  );
  const baseWhere: Prisma.DomainAuditEventWhereInput = {
    AND: [
      activityTargetWhere(parsed.targetType, parsed.targetId),
      { action: { in: actionNames } },
    ],
  };
  await validateActivityCursor(baseWhere, cursor);
  const rows = await prisma.domainAuditEvent.findMany({
    where: { AND: [baseWhere, cursorWhere(cursor)] },
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      before: true,
      after: true,
      reason: true,
      createdAt: true,
      projectId: true,
      taskId: true,
      project: { select: { id: true, name: true } },
      task: { select: { id: true, title: true } },
      actorPerson: { select: { displayName: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: parsed.limit + 1,
  });
  const entityNames = await loadActivityEntityNames(rows.slice(0, parsed.limit));
  const items = rows.slice(0, parsed.limit).flatMap((row) => {
    const formatted = formatRecentActivityAuditEvent({
      ...row,
      entityName: entityNames.get(`${row.entityType}:${row.entityId}`) ?? null,
    });
    return formatted ? [formatted] : [];
  });
  const last = rows.slice(0, parsed.limit).at(-1);
  return {
    items,
    nextCursor:
      rows.length > parsed.limit && last
        ? encodeKeysetCursor("ACTIVITY", cursorScope, {
            timestamp: last.createdAt,
            id: last.id,
          })
        : null,
  };
}

export async function getActivityVersion(
  actor: ProjectManagementActor,
  input: unknown,
) {
  const parsed = activityVersionInputSchema.parse(input);
  await loadReadableTarget(actor, parsed.targetType, parsed.targetId);
  const latest = await prisma.domainAuditEvent.findFirst({
    where: {
      AND: [
        activityTargetWhere(parsed.targetType, parsed.targetId),
        { action: { in: [...RECENT_ACTIVITY_ACTIONS] } },
      ],
    },
    select: { id: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return {
    token: latest ? `${latest.createdAt.toISOString()}:${latest.id}` : "empty",
  };
}

async function validateActivityCursor(
  where: Prisma.DomainAuditEventWhereInput,
  cursor: TimestampCursor | null,
) {
  if (!cursor) return;
  const row = await prisma.domainAuditEvent.findFirst({
    where: {
      AND: [where, { id: cursor.id, createdAt: cursor.createdAt }],
    },
    select: { id: true },
  });
  if (!row) throw validationError("动态分页游标无效");
}

function activityTargetWhere(
  targetType: TargetType,
  targetId: string,
): Prisma.DomainAuditEventWhereInput {
  if (targetType === "TASK") return { taskId: targetId };
  return {
    OR: [
      { projectId: targetId },
      {
        action: {
          in: [
            "pm.task.project.move",
            "pm.task.project.assign",
            "pm.task.project.remove",
          ],
        },
        before: { path: ["projectId"], equals: targetId },
      },
      {
        action: {
          in: [
            "pm.task.project.move",
            "pm.task.project.assign",
            "pm.task.project.remove",
          ],
        },
        after: { path: ["projectId"], equals: targetId },
      },
    ],
  };
}

async function loadActivityEntityNames(
  rows: Array<{ entityType: string; entityId: string }>,
) {
  const idsFor = (entityType: string) =>
    [...new Set(
      rows
        .filter((row) => row.entityType === entityType)
        .map((row) => row.entityId),
    )];
  const revisionIds = idsFor("RevisionNode");
  const milestoneReviewIds = idsFor("MilestoneReview");
  const terminationReviewIds = idsFor("TerminationReview");
  const terminationIds = idsFor("TerminationNode");
  const segmentIds = idsFor("WorkSegment");
  const [revisions, milestoneReviews, terminationReviews, terminations, segments] = await Promise.all([
    revisionIds.length
      ? prisma.revisionNode.findMany({
          where: { id: { in: revisionIds } },
          select: { id: true, reason: true },
        })
      : [],
    milestoneReviewIds.length
      ? prisma.milestoneReview.findMany({
          where: { id: { in: milestoneReviewIds } },
          select: {
            id: true,
            milestoneNode: { select: { goal: true } },
          },
        })
      : [],
    terminationReviewIds.length
      ? prisma.terminationReview.findMany({
          where: { id: { in: terminationReviewIds } },
          select: {
            id: true,
            terminationNode: { select: { name: true } },
          },
        })
      : [],
    terminationIds.length
      ? prisma.terminationNode.findMany({
          where: { id: { in: terminationIds } },
          select: { id: true, name: true },
        })
      : [],
    segmentIds.length
      ? prisma.workSegment.findMany({
          where: { id: { in: segmentIds } },
          select: {
            id: true,
            person: { select: { displayName: true } },
          },
        })
      : [],
  ]);
  return new Map<string, string>([
    ...revisions.map((revision) => [
      `RevisionNode:${revision.id}`,
      `Revision：${revision.reason}`,
    ] as const),
    ...milestoneReviews.map((review) => [
      `MilestoneReview:${review.id}`,
      `Milestone：${review.milestoneNode.goal}`,
    ] as const),
    ...terminationReviews.map((review) => [
      `TerminationReview:${review.id}`,
      `Terminal：${review.terminationNode.name}`,
    ] as const),
    ...terminations.map((termination) => [
      `TerminationNode:${termination.id}`,
      `Terminal：${termination.name}`,
    ] as const),
    ...segments.map((segment) => [
      `WorkSegment:${segment.id}`,
      `${segment.person.displayName}的人员投入`,
    ] as const),
  ]);
}
