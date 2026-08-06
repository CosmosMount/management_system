import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  authorize,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import { notFoundError, validationError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

export type TaskLifecycleViews = {
  reviews: Array<{
    id: string;
    milestoneNodeId: string;
    taskNodeId: string;
    milestoneGoal: string;
    result: string;
    submittedBy: string;
    reviewer: string | null;
    reviewedAt: string | null;
    comment: string;
    revokedAt: string | null;
    createdAt: string;
    evidences: Array<{
      id: string;
      kind: "TEXT" | "LINK" | "FILE";
      note: string;
      externalUrl: string | null;
    }>;
    capabilities: {
      canReview: boolean;
    };
  }>;
  nextReviewCursor: string | null;
  revisions: Array<{
    id: string;
    taskNodeId: string;
    reason: string;
    description: string;
    revisionAt: string;
    reviewRound: number;
    createdAt: string;
    basePlanVersionId: string;
    baseTaskLockVersion: number;
    targetPlanVersionId: string | null;
    targetVersionNo: number | null;
    status: string;
    reviewedAt: string | null;
    effectiveAt: string | null;
    reviewer: string | null;
    reviewComment: string;
    affectedSummary: unknown;
    capabilities: {
      canEdit: boolean;
      canReview: boolean;
      canCancel: boolean;
    };
  }>;
  nextRevisionCursor: string | null;
  audits: Array<{
    id: string;
    action: string;
    entityType: string;
    actor: string;
    reason: string;
    source: string;
    before: unknown;
    after: unknown;
    createdAt: string;
  }>;
  nextAuditCursor: string | null;
  auditFilterOptions: {
    eventTypes: string[];
    actors: Array<{ value: string; label: string }>;
  };
};

export type RevisionComposerRecord = {
  id: string;
  taskNodeId: string;
  taskId: string;
  reason: string;
  description: string;
  revisionAt: string;
  reviewRound: number;
  status: string;
  basePlanVersionId: string;
  baseTaskLockVersion: number;
  targetPlanVersionId: string | null;
  targetVersionNo: number | null;
  targetPlanUpdatedAt: string | null;
  canEdit: boolean;
};

export async function getOpenRevisionCandidate({
  actor,
  taskId,
}: {
  actor: ProjectManagementActor;
  taskId: string;
}) {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, taskReadableWhere(actor)] },
    select: { id: true },
  });
  if (!task) throw notFoundError();
  return prisma.taskPlanVersion.findFirst({
    where: {
      taskId,
      status: "DRAFT",
      revisionNodeId: { not: null },
    },
    select: {
      id: true,
      revisionNodeId: true,
      revisionNode: { select: { status: true } },
    },
  });
}

export async function getRevisionComposerRecord({
  actor,
  taskId,
  revisionNodeId,
}: {
  actor: ProjectManagementActor;
  taskId: string;
  revisionNodeId: string;
}): Promise<RevisionComposerRecord> {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, taskReadableWhere(actor)] },
    select: {
      id: true,
      team: true,
      techGroup: true,
      status: true,
      priority: true,
      members: {
        where: { removedAt: null },
        select: { personId: true, role: true, removedAt: true },
      },
    },
  });
  if (!task) throw notFoundError();
  const revision = await prisma.revisionNode.findFirst({
    where: { id: revisionNodeId, node: { taskId } },
    select: {
      id: true,
      reason: true,
      revisionAt: true,
      reviewRound: true,
      status: true,
      basePlanVersionId: true,
      baseTaskLockVersion: true,
      node: {
        select: { id: true, businessDescription: true, createdByAccountId: true },
      },
      targetPlanVersion: {
        select: { id: true, versionNo: true, updatedAt: true },
      },
    },
  });
  if (!revision) throw notFoundError();
  const resource: AuthorizationTaskResource = { type: "task", ...task };
  assertAuthorized({ actor, action: "task.view", resource });
  const canCreateRevision = authorize({
    actor,
    action: "revision.create",
    resource,
  }).allowed;
  const canManageMembers = authorize({
    actor,
    action: "task.manage_members",
    resource,
  }).allowed;
  return {
    id: revision.id,
    taskNodeId: revision.node.id,
    taskId,
    reason: revision.reason,
    description: revision.node.businessDescription,
    revisionAt: revision.revisionAt.toISOString(),
    reviewRound: revision.reviewRound,
    status: revision.status,
    basePlanVersionId: revision.basePlanVersionId,
    baseTaskLockVersion: revision.baseTaskLockVersion,
    targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
    targetVersionNo: revision.targetPlanVersion?.versionNo ?? null,
    targetPlanUpdatedAt:
      revision.targetPlanVersion?.updatedAt.toISOString() ?? null,
    canEdit:
      revision.status === "REJECTED" &&
      ((revision.node.createdByAccountId === actor.accountId &&
        canCreateRevision) ||
        canManageMembers),
  };
}

export async function getTaskLifecycleViews({
  actor,
  taskId,
  reviewCursor,
  reviewLimit = 50,
  revisionCursor,
  revisionLimit = 50,
  auditCursor,
  auditLimit = 50,
  auditEventTypes = [],
  auditActor,
  currentOnly = false,
}: {
  actor: ProjectManagementActor;
  taskId: string;
  reviewCursor?: string;
  reviewLimit?: number;
  revisionCursor?: string;
  revisionLimit?: number;
  auditCursor?: string;
  auditLimit?: number;
  auditEventTypes?: string[];
  auditActor?: string;
  currentOnly?: boolean;
}): Promise<TaskLifecycleViews> {
  if (!Number.isInteger(reviewLimit) || reviewLimit < 1 || reviewLimit > 100) {
    throw validationError("验收分页数量必须为 1–100");
  }
  if (!Number.isInteger(auditLimit) || auditLimit < 1 || auditLimit > 100) {
    throw validationError("审计分页数量必须为 1–100");
  }
  if (!Number.isInteger(revisionLimit) || revisionLimit < 1 || revisionLimit > 100) {
    throw validationError("修订分页数量必须为 1–100");
  }
  if (
    auditEventTypes.length > 20 ||
    auditEventTypes.some(
      (eventType) =>
        typeof eventType !== "string" ||
        eventType.trim().length < 1 ||
        eventType.length > 120,
    )
  ) {
    throw validationError("审计事件筛选不正确");
  }
  if (
    auditActor !== undefined &&
    auditActor !== "SYSTEM" &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(auditActor)
  ) {
    throw validationError("审计操作者筛选不正确");
  }
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, taskReadableWhere(actor)] },
    select: {
      id: true,
      team: true,
      techGroup: true,
      status: true,
      priority: true,
      members: {
        where: { removedAt: null },
        select: { personId: true, role: true, removedAt: true },
      },
    },
  });
  if (!task) throw notFoundError();
  const resource: AuthorizationTaskResource = { type: "task", ...task };
  assertAuthorized({ actor, action: "task.view", resource });
  if (!currentOnly) {
    assertAuthorized({
      actor,
      action: "audit.view",
      resource: { type: "audit", task: resource },
    });
  }
  const auditWhere: Prisma.DomainAuditEventWhereInput = {
    taskId,
    ...(auditEventTypes.length > 0
      ? { action: { in: auditEventTypes.map((value) => value.trim()) } }
      : {}),
    ...(auditActor === "SYSTEM"
      ? { actorPersonId: null }
      : auditActor
        ? { actorPersonId: auditActor }
        : {}),
  };
  if (reviewCursor) {
    const cursor = await prisma.milestoneReview.findFirst({
      where: {
        id: reviewCursor,
        milestoneNode: { node: { taskId } },
      },
      select: { id: true },
    });
    if (!cursor) throw validationError("验收分页游标无效");
  }
  if (auditCursor) {
    const cursor = await prisma.domainAuditEvent.findFirst({
      where: { AND: [auditWhere, { id: auditCursor }] },
      select: { id: true },
    });
    if (!cursor) throw validationError("审计分页游标无效");
  }
  if (revisionCursor) {
    const cursor = await prisma.revisionNode.findFirst({
      where: { id: revisionCursor, node: { taskId } },
      select: { id: true },
    });
    if (!cursor) throw validationError("修订分页游标无效");
  }

  const [reviewRows, revisionRows, auditBundle] = await Promise.all([
    prisma.milestoneReview.findMany({
      where: {
        milestoneNode: { node: { taskId } },
        ...(currentOnly ? { result: "PENDING" as const, revokedAt: null } : {}),
      },
      include: {
        milestoneNode: {
          select: { goal: true, nodeId: true },
        },
        submittedBy: { select: { person: { select: { displayName: true } } } },
        reviewer: { select: { person: { select: { displayName: true } } } },
        evidences: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            kind: true,
            note: true,
            externalUrl: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: currentOnly ? reviewLimit : reviewLimit + 1,
      ...(reviewCursor ? { cursor: { id: reviewCursor }, skip: 1 } : {}),
    }),
    prisma.revisionNode.findMany({
      where: {
        node: { taskId },
        ...(currentOnly
          ? { status: { in: ["PENDING_APPROVAL", "REJECTED"] as const } }
          : {}),
      },
      include: {
        node: {
          select: {
            id: true,
            businessDescription: true,
            createdByAccountId: true,
            createdAt: true,
          },
        },
        targetPlanVersion: { select: { id: true, versionNo: true } },
        reviewedBy: { select: { person: { select: { displayName: true } } } },
      },
      orderBy: [{ node: { createdAt: "desc" } }, { id: "desc" }],
      take: currentOnly ? revisionLimit : revisionLimit + 1,
      ...(revisionCursor ? { cursor: { id: revisionCursor }, skip: 1 } : {}),
    }),
    currentOnly
      ? Promise.resolve([[], [], [], 0] as const)
      : Promise.all([
          prisma.domainAuditEvent.findMany({
            where: auditWhere,
            include: { actorPerson: { select: { displayName: true } } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: auditLimit + 1,
            ...(auditCursor ? { cursor: { id: auditCursor }, skip: 1 } : {}),
          }),
          prisma.domainAuditEvent.findMany({
            where: { taskId },
            select: { action: true },
            distinct: ["action"],
            orderBy: { action: "asc" },
          }),
          prisma.domainAuditEvent.findMany({
            where: { taskId, actorPersonId: { not: null } },
            select: {
              actorPersonId: true,
              actorPerson: { select: { displayName: true } },
            },
            distinct: ["actorPersonId"],
            orderBy: { actorPersonId: "asc" },
          }),
          prisma.domainAuditEvent.count({ where: { taskId, actorPersonId: null } }),
        ]),
  ]);
  const [auditRows, auditEventTypeRows, auditActorRows, systemAuditCount] = auditBundle;
  const canCreateRevision = authorize({
    actor,
    action: "revision.create",
    resource,
  }).allowed;
  const canApplyRevision = authorize({
    actor,
    action: "task.manage_members",
    resource,
  }).allowed;
  const visibleAuditRows = currentOnly ? [] : auditRows.slice(0, auditLimit);
  const visibleReviewRows = reviewRows.slice(0, reviewLimit);
  const visibleRevisionRows = revisionRows.slice(0, revisionLimit);

  return {
    reviews: visibleReviewRows.map((review) => ({
      id: review.id,
      milestoneNodeId: review.milestoneNodeId,
      taskNodeId: review.milestoneNode.nodeId,
      milestoneGoal: review.milestoneNode.goal,
      result: review.result,
      submittedBy: review.submittedBy?.person?.displayName ?? "未知提交人",
      reviewer: review.reviewer?.person?.displayName ?? null,
      reviewedAt: review.reviewedAt?.toISOString() ?? null,
      comment: review.comment,
      revokedAt: review.revokedAt?.toISOString() ?? null,
      createdAt: review.createdAt.toISOString(),
      evidences: review.evidences.map((evidence) => ({
        ...evidence,
        externalUrl:
          evidence.kind === "LINK" && safeHttpUrl(evidence.externalUrl)
            ? evidence.externalUrl
            : null,
      })),
      capabilities: {
        canReview:
          review.result === "PENDING" &&
          review.revokedAt === null &&
          authorize({
            actor,
            action: "milestone.review",
            resource,
          }).allowed,
      },
    })),
    nextReviewCursor:
      !currentOnly && reviewRows.length > reviewLimit
        ? visibleReviewRows.at(-1)?.id ?? null
        : null,
    revisions: visibleRevisionRows.map((revision) => ({
      id: revision.id,
      taskNodeId: revision.node.id,
      reason: revision.reason,
      description: revision.node.businessDescription,
      revisionAt: revision.revisionAt.toISOString(),
      reviewRound: revision.reviewRound,
      createdAt: revision.node.createdAt.toISOString(),
      basePlanVersionId: revision.basePlanVersionId,
      baseTaskLockVersion: revision.baseTaskLockVersion,
      targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
      targetVersionNo: revision.targetPlanVersion?.versionNo ?? null,
      status: revision.status,
      reviewedAt: revision.reviewedAt?.toISOString() ?? null,
      effectiveAt: revision.effectiveAt?.toISOString() ?? null,
      reviewer: revision.reviewedBy?.person?.displayName ?? null,
      reviewComment: revision.reviewComment,
      affectedSummary: redactAuditValue(revision.affectedSummary),
      capabilities: {
        canEdit:
          revision.status === "REJECTED" &&
          ((revision.node.createdByAccountId === actor.accountId &&
            canCreateRevision) ||
            canApplyRevision),
        canReview:
          revision.status === "PENDING_APPROVAL" &&
          authorize({
            actor,
            action: "revision.review",
            resource,
          }).allowed,
        canCancel:
          ["PENDING_APPROVAL", "REJECTED"].includes(revision.status) &&
          ((revision.node.createdByAccountId === actor.accountId &&
            canCreateRevision) ||
            canApplyRevision),
      },
    })),
    nextRevisionCursor:
      !currentOnly && revisionRows.length > revisionLimit
        ? visibleRevisionRows.at(-1)?.id ?? null
        : null,
    audits: visibleAuditRows.map((audit) => ({
      id: audit.id,
      action: audit.action,
      entityType: audit.entityType,
      actor: audit.actorPerson?.displayName ?? "系统",
      reason: truncate(audit.reason, 1_000),
      source: audit.source,
      before: redactAuditValue(audit.before),
      after: redactAuditValue(audit.after),
      createdAt: audit.createdAt.toISOString(),
    })),
    nextAuditCursor:
      !currentOnly && auditRows.length > auditLimit
        ? visibleAuditRows.at(-1)?.id ?? null
        : null,
    auditFilterOptions: {
      eventTypes: auditEventTypeRows.map((row) => row.action),
      actors: [
        ...(systemAuditCount > 0 ? [{ value: "SYSTEM", label: "系统" }] : []),
        ...auditActorRows.flatMap((row) =>
          row.actorPersonId
            ? [{
                value: row.actorPersonId,
                label: row.actorPerson?.displayName ?? "未知操作者",
              }]
            : [],
        ),
      ],
    },
  };
}

function safeHttpUrl(value: string | null) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function redactAuditValue(
  value: Prisma.JsonValue | null | undefined,
  depth = 0,
): unknown {
  if (value === null || value === undefined) return null;
  if (depth >= 5) return "[内容已折叠]";
  if (typeof value === "string") return truncate(value, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactAuditValue(item, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    if (sensitiveAuditKey(key)) {
      output[key] = "[已脱敏]";
      continue;
    }
    output[key] = redactAuditValue(child, depth + 1);
  }
  return output;
}

function sensitiveAuditKey(key: string) {
  const normalized = key.toLowerCase();
  return [
    "openid",
    "unionid",
    "token",
    "secret",
    "password",
    "idempotencykey",
    "creationrequesthash",
    "requestid",
    "accountid",
    "personid",
  ].some((part) => normalized.includes(part));
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
