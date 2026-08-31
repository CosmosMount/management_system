import type {
  MilestoneReviewResult,
  PlanVersionStatus,
  Prisma,
  RevisionStatus,
  TaskMemberRole,
  TaskNodeStatus,
  TaskNodeType,
  TaskPriority,
  TaskStatus,
  TerminationOutcome,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import { notFoundError } from "@/lib/project-management/application/errors";
import { inspectPlanChronology } from "@/lib/project-management/domain/plan-chronology";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { safeHttpUrl } from "@/lib/project-management/queries/safe-http-url";

export const planVersionInclude = {
  nodes: {
    include: {
      node: {
        include: {
          milestone: {
            include: {
              reviews: {
                where: { revokedAt: null },
                orderBy: { createdAt: "desc" },
                select: { result: true },
                take: 1,
              },
            },
          },
          revision: {
            include: {
              targetPlanVersion: { select: { id: true } },
            },
          },
          termination: true,
          planVersionEntries: {
            take: 2,
            select: { planVersionId: true },
          },
        },
      },
    },
    orderBy: { sequence: "asc" },
  },
} satisfies Prisma.TaskPlanVersionInclude;

export type PlanVersionWithNodes = Prisma.TaskPlanVersionGetPayload<{
  include: typeof planVersionInclude;
}>;


type PlanNodeSummary = {
  planVersionNodeId: string;
  nodeId: string;
  sequence: number;
  isCarryForward: boolean;
  type: TaskNodeType;
  status: TaskNodeStatus;
  businessDescription: string;
  milestone: {
    id: string;
    goal: string;
    completionCriteria: string;
    expectedCompletedAt: string;
    reviewRequirements: string;
    submittedForReviewAt: string | null;
    completedAt: string | null;
    latestReviewResult: MilestoneReviewResult | null;
  } | null;
  revision: {
    id: string;
    reason: string;
    revisionAt: string;
    reviewRound: number;
    basePlanVersionId: string;
    baseTaskLockVersion: number;
    targetPlanVersionId: string | null;
    status: RevisionStatus;
    reviewedAt: string | null;
    effectiveAt: string | null;
    reviewComment: string;
  } | null;
  termination: {
    id: string;
    name: string;
    plannedOutcomeCriteria: string;
    plannedAt: string;
    outcome: TerminationOutcome | null;
    reason: string;
    summary: string;
    confirmedAt: string | null;
  } | null;
};


export type MilestoneCompletionDetails = {
  nodeId: string;
  completedAt: string;
  evidences: Array<{
    id: string;
    kind: "TEXT" | "LINK" | "FILE";
    note: string;
    externalUrl: string | null;
  }>;
};

export type RevisionBasePlanDetails = {
  revisionNodeId: string;
  revisionReason: string;
  revisionAt: string;
  plan: PlanVersionSummary;
};


export type PlanVersionSummary = {
  id: string;
  taskId: string;
  versionNo: number;
  status: PlanVersionStatus;
  baseVersionId: string | null;
  revisionNodeId: string | null;
  reason: string;
  plannedStartAt: string | null;
  activatedAt: string | null;
  snapshotHash: string;
  createdAt: string;
  updatedAt: string;
  chronologyCompatibilityIssues: Array<{ path: string; message: string }>;
  nodes: PlanNodeSummary[];
};

export type PlanVersionDiff = {
  fromPlanVersionId: string;
  toPlanVersionId: string;
  planChanges: {
    plannedStartAt: {
      before: string | null;
      after: string | null;
    } | null;
  };
  added: PlanNodeSummary[];
  removed: PlanNodeSummary[];
  moved: Array<{
    nodeId: string;
    fromSequence: number;
    toSequence: number;
  }>;
  changed: Array<{
    nodeId: string;
    before: PlanNodeSummary;
    after: PlanNodeSummary;
  }>;
};

export async function getMilestoneCompletionDetails({
  actor,
  taskId,
  nodeId,
}: {
  actor: ProjectManagementActor;
  taskId: string;
  nodeId: string;
}): Promise<MilestoneCompletionDetails> {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, taskReadableWhere(actor)] },
    select: { currentPlanVersionId: true },
  });
  if (!task) throw notFoundError();

  const milestone = await prisma.milestoneNode.findFirst({
    where: {
      nodeId,
      node: {
        taskId,
        status: "COMPLETED",
        deletedAt: null,
        planVersionEntries: {
          some: { planVersionId: task.currentPlanVersionId },
        },
      },
    },
    select: {
      nodeId: true,
      completedAt: true,
      reviews: {
        where: { result: "APPROVED", revokedAt: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          evidences: {
            orderBy: [
              { sortOrder: "asc" },
              { createdAt: "asc" },
              { id: "asc" },
            ],
            select: {
              id: true,
              kind: true,
              note: true,
              externalUrl: true,
            },
          },
        },
      },
    },
  });
  if (!milestone?.completedAt) throw notFoundError();

  return {
    nodeId: milestone.nodeId,
    completedAt: milestone.completedAt.toISOString(),
    evidences: (milestone.reviews[0]?.evidences ?? []).map((evidence) => ({
      id: evidence.id,
      kind: evidence.kind,
      note: evidence.note,
      externalUrl:
        evidence.kind === "LINK" && safeHttpUrl(evidence.externalUrl)
          ? evidence.externalUrl
          : null,
    })),
  };
}

export async function getRevisionBasePlan({
  actor,
  taskId,
  revisionNodeId,
}: {
  actor: ProjectManagementActor;
  taskId: string;
  revisionNodeId: string;
}): Promise<RevisionBasePlanDetails> {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, taskReadableWhere(actor)] },
    select: {
      id: true,
      team: true,
      techGroup: true,
      status: true,
      priority: true,
      createdByAccountId: true,
      currentPlanVersionId: true,
      members: {
        where: { removedAt: null },
        select: { personId: true, role: true, removedAt: true },
      },
    },
  });
  if (!task) throw notFoundError();
  assertAuthorized({
    actor,
    action: "plan.view_history",
    resource: taskResource(task),
  });

  const revision = await prisma.revisionNode.findFirst({
    where: {
      id: revisionNodeId,
      status: "EFFECTIVE",
      node: {
        taskId,
        deletedAt: null,
        planVersionEntries: {
          some: { planVersionId: task.currentPlanVersionId },
        },
      },
    },
    select: {
      id: true,
      reason: true,
      revisionAt: true,
      basePlanVersion: { include: planVersionInclude },
    },
  });
  if (!revision || revision.basePlanVersion.taskId !== taskId) {
    throw notFoundError();
  }

  return {
    revisionNodeId: revision.id,
    revisionReason: revision.reason,
    revisionAt: revision.revisionAt.toISOString(),
    plan: serializePlanVersion(revision.basePlanVersion),
  };
}

export async function getPlanVersion({
  actor,
  planVersionId,
}: {
  actor: ProjectManagementActor;
  planVersionId: string;
}): Promise<PlanVersionSummary> {
  const plan = await prisma.taskPlanVersion.findFirst({
    where: {
      id: planVersionId,
      task: taskReadableWhere(actor),
    },
    include: planVersionInclude,
  });
  if (!plan) throw notFoundError();
  return serializePlanVersion(plan);
}

export async function listTaskPlanVersions({
  actor,
  taskId,
}: {
  actor: ProjectManagementActor;
  taskId: string;
}): Promise<
  Array<{
    id: string;
    versionNo: number;
    status: PlanVersionStatus;
    baseVersionId: string | null;
    revisionNodeId: string | null;
    reason: string;
    plannedStartAt: string | null;
    activatedAt: string | null;
    createdAt: string;
  }>
> {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, taskReadableWhere(actor)] },
    select: { id: true },
  });
  if (!task) throw notFoundError();
  const plans = await prisma.taskPlanVersion.findMany({
    where: { taskId },
    orderBy: { versionNo: "desc" },
    select: {
      id: true,
      versionNo: true,
      status: true,
      baseVersionId: true,
      revisionNodeId: true,
      reason: true,
      plannedStartAt: true,
      activatedAt: true,
      createdAt: true,
    },
  });
  return plans.map((plan) => ({
    ...plan,
    plannedStartAt: toIso(plan.plannedStartAt),
    activatedAt: toIso(plan.activatedAt),
    createdAt: plan.createdAt.toISOString(),
  }));
}

export async function comparePlanVersions({
  actor,
  fromPlanVersionId,
  toPlanVersionId,
}: {
  actor: ProjectManagementActor;
  fromPlanVersionId: string;
  toPlanVersionId: string;
}): Promise<PlanVersionDiff> {
  const [fromPlan, toPlan] = await Promise.all([
    prisma.taskPlanVersion.findFirst({
      where: {
        id: fromPlanVersionId,
        task: taskReadableWhere(actor),
      },
      include: planVersionInclude,
    }),
    prisma.taskPlanVersion.findFirst({
      where: {
        id: toPlanVersionId,
        task: taskReadableWhere(actor),
      },
      include: planVersionInclude,
    }),
  ]);
  if (!fromPlan || !toPlan || fromPlan.taskId !== toPlan.taskId) {
    throw notFoundError();
  }
  const fromNodes = serializePlanVersion(fromPlan).nodes;
  const toNodes = serializePlanVersion(toPlan).nodes;
  const fromPlannedStartAt = toIso(fromPlan.plannedStartAt);
  const toPlannedStartAt = toIso(toPlan.plannedStartAt);
  const fromById = new Map(fromNodes.map((node) => [node.nodeId, node]));
  const toById = new Map(toNodes.map((node) => [node.nodeId, node]));
  const added = toNodes.filter((node) => !fromById.has(node.nodeId));
  const removed = fromNodes.filter((node) => !toById.has(node.nodeId));
  const moved: PlanVersionDiff["moved"] = [];
  const changed: PlanVersionDiff["changed"] = [];

  for (const fromNode of fromNodes) {
    const toNode = toById.get(fromNode.nodeId);
    if (!toNode) continue;
    if (fromNode.sequence !== toNode.sequence) {
      moved.push({
        nodeId: fromNode.nodeId,
        fromSequence: fromNode.sequence,
        toSequence: toNode.sequence,
      });
    }
    if (nodeCoreHash(fromNode) !== nodeCoreHash(toNode)) {
      changed.push({ nodeId: fromNode.nodeId, before: fromNode, after: toNode });
    }
  }

  return {
    fromPlanVersionId,
    toPlanVersionId,
    planChanges: {
      plannedStartAt:
        fromPlannedStartAt === toPlannedStartAt
          ? null
          : { before: fromPlannedStartAt, after: toPlannedStartAt },
    },
    added,
    removed,
    moved,
    changed,
  };
}

export function serializePlanVersion(plan: PlanVersionWithNodes): PlanVersionSummary {
  const chronologyCompatibilityIssues = inspectPlanChronology({
    plannedStartAt: plan.plannedStartAt,
    nodes: plan.nodes.map((entry) => ({
      nodeId: entry.nodeId,
      sequence: entry.sequence,
      type: entry.node.type,
      isCarryForward: entry.isCarryForward,
      expectedCompletedAt: entry.node.milestone?.expectedCompletedAt ?? null,
      plannedAt: entry.node.termination?.plannedAt ?? null,
    })),
  });
  return {
    id: plan.id,
    taskId: plan.taskId,
    versionNo: plan.versionNo,
    status: plan.status,
    baseVersionId: plan.baseVersionId,
    revisionNodeId: plan.revisionNodeId,
    reason: plan.reason,
    plannedStartAt: toIso(plan.plannedStartAt),
    activatedAt: toIso(plan.activatedAt),
    snapshotHash: plan.snapshotHash,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    chronologyCompatibilityIssues,
    nodes: plan.nodes.map((entry) => ({
      planVersionNodeId: entry.id,
      nodeId: entry.nodeId,
      sequence: entry.sequence,
      isCarryForward: entry.isCarryForward,
      type: entry.node.type,
      status: entry.node.status,
      businessDescription: entry.node.businessDescription,
      milestone: entry.node.milestone
        ? {
            id: entry.node.milestone.id,
            goal: entry.node.milestone.goal,
            completionCriteria: entry.node.milestone.completionCriteria,
            expectedCompletedAt:
              entry.node.milestone.expectedCompletedAt.toISOString(),
            reviewRequirements: entry.node.milestone.reviewRequirements,
            submittedForReviewAt: toIso(
              entry.node.milestone.submittedForReviewAt,
            ),
            completedAt: toIso(entry.node.milestone.completedAt),
            latestReviewResult: entry.node.milestone.reviews[0]?.result ?? null,
          }
        : null,
      revision: entry.node.revision
        ? {
            id: entry.node.revision.id,
            reason: entry.node.revision.reason,
            revisionAt: entry.node.revision.revisionAt.toISOString(),
            reviewRound: entry.node.revision.reviewRound,
            basePlanVersionId: entry.node.revision.basePlanVersionId,
            baseTaskLockVersion: entry.node.revision.baseTaskLockVersion,
            targetPlanVersionId:
              entry.node.revision.targetPlanVersion?.id ?? null,
            status: entry.node.revision.status,
            reviewedAt: toIso(entry.node.revision.reviewedAt),
            effectiveAt: toIso(entry.node.revision.effectiveAt),
            reviewComment: entry.node.revision.reviewComment,
          }
        : null,
      termination: entry.node.termination
        ? {
            id: entry.node.termination.id,
            name: entry.node.termination.name,
            plannedOutcomeCriteria:
              entry.node.termination.plannedOutcomeCriteria,
            plannedAt: entry.node.termination.plannedAt.toISOString(),
            outcome: entry.node.termination.outcome,
            reason: entry.node.termination.reason,
            summary: entry.node.termination.summary,
            confirmedAt: toIso(entry.node.termination.confirmedAt),
          }
        : null,
    })),
  };
}

export function taskResource(input: {
  team: string;
  techGroup: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdByAccountId: string;
  members: Array<{
    personId: string;
    role: TaskMemberRole;
    removedAt: Date | null;
  }>;
}): AuthorizationTaskResource {
  return {
    type: "task",
    team: input.team,
    techGroup: input.techGroup,
    status: input.status,
    priority: input.priority,
    createdByAccountId: input.createdByAccountId,
    members: input.members,
  };
}

export function toIso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function nodeCoreHash(node: PlanNodeSummary): string {
  return JSON.stringify({
    type: node.type,
    businessDescription: node.businessDescription,
    milestone: node.milestone
      ? {
          goal: node.milestone.goal,
          completionCriteria: node.milestone.completionCriteria,
          expectedCompletedAt: node.milestone.expectedCompletedAt,
          reviewRequirements: node.milestone.reviewRequirements,
        }
      : null,
    revision: node.revision
      ? {
          reason: node.revision.reason,
          revisionAt: node.revision.revisionAt,
          reviewRound: node.revision.reviewRound,
          basePlanVersionId: node.revision.basePlanVersionId,
        }
      : null,
    termination: node.termination
      ? {
          name: node.termination.name,
          plannedOutcomeCriteria: node.termination.plannedOutcomeCriteria,
          plannedAt: node.termination.plannedAt,
        }
      : null,
  });
}
