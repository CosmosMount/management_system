import type { Prisma, RiskRecordStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authorize,
  isSystemAdministrator,
  projectReadableWhere,
  taskReadableWhere,
  type AuthorizationProjectResource,
  type AuthorizationResource,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import {
  notFoundError,
  validationError,
} from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  actionsForActivityFilter,
  formatRecentActivityAuditEvent,
  RECENT_ACTIVITY_ACTIONS,
  type RecentActivityItemDto,
} from "@/lib/project-management/recent-activity-formatter";
import {
  activityVersionInputSchema,
  commentPageInputSchema,
  recentActivityPageInputSchema,
  riskPageInputSchema,
} from "@/lib/project-management/validations/collaboration";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "@/lib/project-management/queries/keyset-cursor";

type TargetType = "PROJECT" | "TASK";
type TimestampCursor = { createdAt: Date; id: string };

export type RiskItemDto = {
  id: string;
  content: string;
  status: RiskRecordStatus;
  createdByName: string;
  createdAt: string;
  resolvedByName: string | null;
  resolveNote: string | null;
  resolvedAt: string | null;
  target: { type: TargetType; id: string; name: string };
  canResolve: boolean;
};

export type RiskPageDto = {
  items: RiskItemDto[];
  totalCount: number;
  nextCursor: string | null;
};

export type CommentItemDto = {
  id: string;
  authorName: string;
  authorInactive: boolean;
  content: string;
  createdAt: string;
  canDelete: boolean;
};

export type CommentPageDto = {
  items: CommentItemDto[];
  totalCount: number;
  nextCursor: string | null;
};

export type { RecentActivityItemDto } from "@/lib/project-management/recent-activity-formatter";

export type RecentActivityPageDto = {
  items: RecentActivityItemDto[];
  nextCursor: string | null;
};

export type CollaborationCapabilities = {
  canCreateRisk: boolean;
  canCreateComment: boolean;
  canDeleteComment: boolean;
};

export async function getCollaborationCapabilities(
  actor: ProjectManagementActor,
  input: { targetType: TargetType; targetId: string },
): Promise<CollaborationCapabilities> {
  const target = await loadReadableTarget(actor, input.targetType, input.targetId);
  const resource = targetResource(target);
  const canCreateRisk =
    target.status === "ACTIVE" &&
    authorize({
      actor,
      action: target.type === "PROJECT" ? "project.risk.create" : "task.risk.create",
      resource,
    }).allowed;
  return {
    canCreateRisk,
    canCreateComment: authorize({
      actor,
      action:
        target.type === "PROJECT"
          ? "project.comment.create"
          : "task.comment.create",
      resource,
    }).allowed,
    canDeleteComment: isSystemAdministrator(actor),
  };
}

export async function getRiskPage(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RiskPageDto> {
  const parsed = riskPageInputSchema.parse(input);
  await loadReadableTarget(actor, parsed.targetType, parsed.targetId);
  if (parsed.source === "TASKS" && parsed.targetType !== "PROJECT") {
    throw validationError("只有 Project 可以汇总所属 Task 风险");
  }
  const cursorScope = JSON.stringify({
    targetType: parsed.targetType,
    targetId: parsed.targetId,
    source: parsed.source,
    status: parsed.status,
  });
  const cursor = toTimestampCursor(
    decodeKeysetCursor(
      parsed.cursor ?? undefined,
      "RISK",
      cursorScope,
      "风险分页游标无效",
    ),
  );
  const baseWhere: Prisma.RiskRecordWhereInput = {
    status: parsed.status,
    ...(parsed.source === "TASKS"
      ? {
          task: {
            projectId: parsed.targetId,
            deletedAt: null,
          },
        }
      : parsed.targetType === "PROJECT"
        ? { projectId: parsed.targetId }
        : { taskId: parsed.targetId }),
  };
  await validateRiskCursor(baseWhere, cursor);
  const where: Prisma.RiskRecordWhereInput = {
    AND: [baseWhere, cursorWhere(cursor)],
  };
  const [rows, totalCount] = await Promise.all([
    prisma.riskRecord.findMany({
      where,
      include: {
        project: { select: { id: true, name: true, status: true, members: { where: { removedAt: null } } } },
        task: {
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            team: true,
            techGroup: true,
            members: { where: { removedAt: null } },
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: parsed.limit + 1,
    }),
    prisma.riskRecord.count({ where: baseWhere }),
  ]);
  const items = rows.slice(0, parsed.limit).map((risk) => {
    const directTarget = risk.project
      ? {
          type: "PROJECT" as const,
          id: risk.project.id,
          name: risk.project.name,
          status: risk.project.status,
          members: risk.project.members,
        }
      : {
          type: "TASK" as const,
          id: risk.task!.id,
          name: risk.task!.title,
          title: risk.task!.title,
          status: risk.task!.status,
          priority: risk.task!.priority,
          team: risk.task!.team,
          techGroup: risk.task!.techGroup,
          members: risk.task!.members,
        };
    return {
      id: risk.id,
      content: risk.content,
      status: risk.status,
      createdByName: risk.createdByName,
      createdAt: risk.createdAt.toISOString(),
      resolvedByName: risk.resolvedByName,
      resolveNote: risk.resolveNote,
      resolvedAt: risk.resolvedAt?.toISOString() ?? null,
      target: {
        type: directTarget.type,
        id: directTarget.id,
        name: directTarget.name,
      },
      canResolve:
        risk.status === "ACTIVE" &&
        directTarget.status !== "DRAFT" &&
        !("status" in directTarget && directTarget.status === "PENDING_APPROVAL") &&
        authorize({
          actor,
          action:
            directTarget.type === "PROJECT"
              ? "project.risk.resolve"
              : "task.risk.resolve",
          resource:
            directTarget.type === "PROJECT"
              ? {
                  type: "project",
                  id: directTarget.id,
                  status: directTarget.status,
                  members: directTarget.members,
                }
              : {
                  type: "task",
                  id: directTarget.id,
                  status: directTarget.status,
                  priority: directTarget.priority,
                  team: directTarget.team,
                  techGroup: directTarget.techGroup,
                  members: directTarget.members,
                },
        }).allowed,
    };
  });
  return {
    items,
    totalCount,
    nextCursor:
      rows.length > parsed.limit && items.at(-1)
        ? encodeKeysetCursor("RISK", cursorScope, {
            timestamp: new Date(items.at(-1)!.createdAt),
            id: items.at(-1)!.id,
          })
        : null,
  };
}

export async function getCommentPage(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<CommentPageDto> {
  const parsed = commentPageInputSchema.parse(input);
  await loadReadableTarget(actor, parsed.targetType, parsed.targetId);
  const cursorScope = JSON.stringify({
    targetType: parsed.targetType,
    targetId: parsed.targetId,
  });
  const cursor = toTimestampCursor(
    decodeKeysetCursor(
      parsed.cursor ?? undefined,
      "COMMENT",
      cursorScope,
      "评论分页游标无效",
    ),
  );
  const baseWhere: Prisma.CommentWhereInput = {
    deletedAt: null,
    ...(parsed.targetType === "PROJECT"
      ? { projectId: parsed.targetId }
      : { taskId: parsed.targetId }),
  };
  await validateCommentCursor(baseWhere, cursor);
  const [rows, totalCount] = await Promise.all([
    prisma.comment.findMany({
      where: { AND: [baseWhere, cursorWhere(cursor)] },
      include: { authorPerson: { select: { status: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: parsed.limit + 1,
    }),
    prisma.comment.count({ where: baseWhere }),
  ]);
  const items = rows.slice(0, parsed.limit).map((comment) => ({
    id: comment.id,
    authorName: comment.authorName,
    authorInactive: comment.authorPerson?.status === "INACTIVE",
    content: comment.content,
    createdAt: comment.createdAt.toISOString(),
    canDelete: isSystemAdministrator(actor),
  }));
  return {
    items,
    totalCount,
    nextCursor:
      rows.length > parsed.limit && items.at(-1)
        ? encodeKeysetCursor("COMMENT", cursorScope, {
            timestamp: new Date(items.at(-1)!.createdAt),
            id: items.at(-1)!.id,
          })
        : null,
  };
}

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

type ReadableTarget =
  | {
      type: "PROJECT";
      id: string;
      status: "DRAFT" | "PENDING_APPROVAL" | "ACTIVE" | "COMPLETED";
      requesterAccountId: string;
      members: Array<{ personId: string; role: "OWNER" | "PARTICIPANT"; removedAt: Date | null }>;
    }
  | {
      type: "TASK";
      id: string;
      status: "DRAFT" | "ACTIVE" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT" | "ARCHIVED";
      priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
      team: string;
      techGroup: string;
      members: Array<{
        personId: string;
        role: "OWNER" | "PARTICIPANT";
        removedAt: Date | null;
      }>;
    };

async function loadReadableTarget(
  actor: ProjectManagementActor,
  targetType: TargetType,
  targetId: string,
): Promise<ReadableTarget> {
  if (targetType === "PROJECT") {
    const project = await prisma.project.findFirst({
      where: { AND: [{ id: targetId }, projectReadableWhere(actor)] },
      select: {
        id: true,
        status: true,
        requesterAccountId: true,
        members: { where: { removedAt: null }, select: { personId: true, role: true, removedAt: true } },
      },
    });
    if (!project) throw notFoundError();
    const resource: AuthorizationProjectResource = { type: "project", ...project };
    if (!authorize({ actor, action: "project.view", resource }).allowed) throw notFoundError();
    return { type: "PROJECT", ...project };
  }
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: targetId }, taskReadableWhere(actor)] },
    select: {
      id: true,
      status: true,
      priority: true,
      team: true,
      techGroup: true,
      members: { where: { removedAt: null }, select: { personId: true, role: true, removedAt: true } },
    },
  });
  if (!task) throw notFoundError();
  const resource: AuthorizationTaskResource = { type: "task", ...task };
  if (!authorize({ actor, action: "task.view", resource }).allowed) throw notFoundError();
  return { type: "TASK", ...task };
}

function targetResource(target: ReadableTarget): AuthorizationResource {
  if (target.type === "PROJECT") {
    return {
      type: "project",
      id: target.id,
      status: target.status,
      requesterAccountId: target.requesterAccountId,
      members: target.members,
    };
  }
  return {
    type: "task",
    id: target.id,
    status: target.status,
    priority: target.priority,
    team: target.team,
    techGroup: target.techGroup,
    members: target.members,
  };
}

function cursorWhere(cursor: TimestampCursor | null) {
  return cursor
    ? {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }
    : {};
}

function toTimestampCursor(
  cursor: { timestamp: Date; id: string } | null,
): TimestampCursor | null {
  return cursor ? { createdAt: cursor.timestamp, id: cursor.id } : null;
}

async function validateRiskCursor(
  where: Prisma.RiskRecordWhereInput,
  cursor: TimestampCursor | null,
) {
  if (!cursor) return;
  const row = await prisma.riskRecord.findFirst({ where: { AND: [where, { id: cursor.id, createdAt: cursor.createdAt }] }, select: { id: true } });
  if (!row) throw validationError("风险分页游标无效");
}

async function validateCommentCursor(
  where: Prisma.CommentWhereInput,
  cursor: TimestampCursor | null,
) {
  if (!cursor) return;
  const row = await prisma.comment.findFirst({ where: { AND: [where, { id: cursor.id, createdAt: cursor.createdAt }] }, select: { id: true } });
  if (!row) throw validationError("评论分页游标无效");
}

async function validateActivityCursor(
  where: Prisma.DomainAuditEventWhereInput,
  cursor: TimestampCursor | null,
) {
  if (!cursor) return;
  const row = await prisma.domainAuditEvent.findFirst({ where: { AND: [where, { id: cursor.id, createdAt: cursor.createdAt }] }, select: { id: true } });
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
        action: { in: ["pm.task.project.move", "pm.task.project.assign", "pm.task.project.remove"] },
        before: { path: ["projectId"], equals: targetId },
      },
      {
        action: { in: ["pm.task.project.move", "pm.task.project.assign", "pm.task.project.remove"] },
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
