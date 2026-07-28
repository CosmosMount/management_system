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
  authorize,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { notFoundError } from "@/lib/project-management/application/errors";

const planVersionInclude = {
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
        },
      },
    },
    orderBy: { sequence: "asc" },
  },
} satisfies Prisma.TaskPlanVersionInclude;

type PlanVersionWithNodes = Prisma.TaskPlanVersionGetPayload<{
  include: typeof planVersionInclude;
}>;

type TaskMemberSummary = {
  personId: string;
  role: TaskMemberRole;
  displayName: string;
};

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
    revisedFromNodeId: string | null;
    basePlanVersionId: string;
    baseTaskLockVersion: number;
    targetPlanVersionId: string | null;
    status: RevisionStatus;
    submittedAt: string | null;
    reviewedAt: string | null;
    effectiveAt: string | null;
    reviewComment: string;
  } | null;
  termination: {
    id: string;
    plannedOutcomeCriteria: string;
    plannedAt: string;
    outcome: TerminationOutcome | null;
    reason: string;
    summary: string;
    confirmedAt: string | null;
  } | null;
};

export type TaskWorkspace = {
  task: {
    id: string;
    title: string;
    description: string;
    team: string;
    techGroup: string;
    status: TaskStatus;
    priority: TaskPriority;
    currentPlanVersionId: string;
    activeMilestoneNodeId: string | null;
    revisionApprovalMode: string;
    allowSelfReview: boolean;
    lockVersion: number;
    startedAt: string | null;
    endedAt: string | null;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  members: TaskMemberSummary[];
  tags: Array<{ id: string; name: string; color: string }>;
  currentPlan: PlanVersionSummary;
  permissions: {
    canUpdateMetadata: boolean;
    canManageMembers: boolean;
    canActivate: boolean;
    canCreateRevision: boolean;
    canSubmitMilestoneReview: boolean;
    canReviewMilestone: boolean;
    canTerminate: boolean;
    canViewHistory: boolean;
  };
};

export type PlanVersionSummary = {
  id: string;
  taskId: string;
  versionNo: number;
  status: PlanVersionStatus;
  baseVersionId: string | null;
  revisionNodeId: string | null;
  reason: string;
  activatedAt: string | null;
  snapshotHash: string;
  createdAt: string;
  updatedAt: string;
  nodes: PlanNodeSummary[];
};

export type PlanVersionDiff = {
  fromPlanVersionId: string;
  toPlanVersionId: string;
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

export async function getTaskWorkspace({
  actor,
  taskId,
}: {
  actor: ProjectManagementActor;
  taskId: string;
}): Promise<TaskWorkspace> {
  const task = await prisma.task.findFirst({
    where: { AND: [{ id: taskId }, taskReadableWhere(actor)] },
    include: {
      members: {
        where: { removedAt: null },
        include: { person: { select: { displayName: true } } },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      },
      tags: {
        include: { tag: { select: { id: true, name: true, color: true } } },
        orderBy: { createdAt: "asc" },
      },
      currentPlanVersion: {
        include: planVersionInclude,
      },
    },
  });
  if (!task) throw notFoundError();

  const resource = taskResource({
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    priority: task.priority,
    allowSelfReview: task.allowSelfReview,
    members: task.members,
  });

  return {
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      team: task.team,
      techGroup: task.techGroup,
      status: task.status,
      priority: task.priority,
      currentPlanVersionId: task.currentPlanVersionId,
      activeMilestoneNodeId: task.activeMilestoneNodeId,
      revisionApprovalMode: task.revisionApprovalMode,
      allowSelfReview: task.allowSelfReview,
      lockVersion: task.lockVersion,
      startedAt: toIso(task.startedAt),
      endedAt: toIso(task.endedAt),
      archivedAt: toIso(task.archivedAt),
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    },
    members: task.members.map((member) => ({
      personId: member.personId,
      role: member.role,
      displayName: member.person.displayName,
    })),
    tags: task.tags.map((entry) => entry.tag),
    currentPlan: serializePlanVersion(task.currentPlanVersion),
    permissions: {
      canUpdateMetadata: allowed(actor, "task.update_metadata", resource),
      canManageMembers: allowed(actor, "task.manage_members", resource),
      canActivate: allowed(actor, "task.activate", resource),
      canCreateRevision: allowed(actor, "revision.create", resource),
      canSubmitMilestoneReview: allowed(
        actor,
        "milestone.submit_review",
        resource,
      ),
      canReviewMilestone: allowed(actor, "milestone.review", resource),
      canTerminate: allowed(actor, "task.terminate", resource),
      canViewHistory: allowed(actor, "plan.view_history", resource),
    },
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
      activatedAt: true,
      createdAt: true,
    },
  });
  return plans.map((plan) => ({
    ...plan,
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
    added,
    removed,
    moved,
    changed,
  };
}

function serializePlanVersion(plan: PlanVersionWithNodes): PlanVersionSummary {
  return {
    id: plan.id,
    taskId: plan.taskId,
    versionNo: plan.versionNo,
    status: plan.status,
    baseVersionId: plan.baseVersionId,
    revisionNodeId: plan.revisionNodeId,
    reason: plan.reason,
    activatedAt: toIso(plan.activatedAt),
    snapshotHash: plan.snapshotHash,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
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
            revisedFromNodeId: entry.node.revision.revisedFromNodeId,
            basePlanVersionId: entry.node.revision.basePlanVersionId,
            baseTaskLockVersion: entry.node.revision.baseTaskLockVersion,
            targetPlanVersionId:
              entry.node.revision.targetPlanVersion?.id ?? null,
            status: entry.node.revision.status,
            submittedAt: toIso(entry.node.revision.submittedAt),
            reviewedAt: toIso(entry.node.revision.reviewedAt),
            effectiveAt: toIso(entry.node.revision.effectiveAt),
            reviewComment: entry.node.revision.reviewComment,
          }
        : null,
      termination: entry.node.termination
        ? {
            id: entry.node.termination.id,
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

function taskResource(input: {
  team: string;
  techGroup: string;
  status: TaskStatus;
  priority: TaskPriority;
  allowSelfReview: boolean;
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
    allowSelfReview: input.allowSelfReview,
    members: input.members,
  };
}

function allowed(
  actor: ProjectManagementActor,
  action: Parameters<typeof authorize>[0]["action"],
  resource: AuthorizationTaskResource,
): boolean {
  return authorize({ actor, action, resource }).allowed;
}

function toIso(date: Date | null): string | null {
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
          revisedFromNodeId: node.revision.revisedFromNodeId,
          basePlanVersionId: node.revision.basePlanVersionId,
        }
      : null,
    termination: node.termination
      ? {
          plannedOutcomeCriteria: node.termination.plannedOutcomeCriteria,
          plannedAt: node.termination.plannedAt,
        }
      : null,
  });
}
