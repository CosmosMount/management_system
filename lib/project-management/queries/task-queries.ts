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
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";
import { inspectPlanChronology } from "@/lib/project-management/domain/plan-chronology";
import {
  normalizeSearchText,
  searchTerms,
} from "@/lib/search/normalize-search-text";

export type TaskListItem = {
  id: string;
  title: string;
  description: string;
  team: string;
  techGroup: string;
  status: TaskStatus;
  priority: TaskPriority;
  currentPlanVersionNo: number;
  lockVersion: number;
  activeMilestone: {
    nodeId: string;
    goal: string;
    expectedCompletedAt: string;
  } | null;
  activeTermination: {
    nodeId: string;
    name: string;
    plannedAt: string;
  } | null;
  members: TaskMemberSummary[];
  tags: Array<{ id: string; name: string; color: string }>;
  updatedAt: string;
  createdAt: string;
};

export type TaskListResult = {
  items: TaskListItem[];
  nextCursor: string | null;
  hasMoreByQuery: boolean;
};

const taskListInclude = {
  currentPlanVersion: {
    select: {
      versionNo: true,
      nodes: {
        where: {
          node: { type: "TERMINATION", status: "ACTIVE", deletedAt: null },
        },
        take: 1,
        select: {
          node: {
            select: {
              id: true,
              termination: { select: { name: true, plannedAt: true } },
            },
          },
        },
      },
    },
  },
  activeMilestoneNode: {
    include: {
      milestone: true,
    },
  },
  members: {
    where: { removedAt: null },
    include: { person: { select: { displayName: true } } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  },
  tags: {
    include: { tag: { select: { id: true, name: true, color: true } } },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.TaskInclude;

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

export type TaskWorkspace = {
  task: {
    id: string;
    title: string;
    description: string;
    team: string;
    techGroup: string;
    status: TaskStatus;
    priority: TaskPriority;
    relatedTaskId: string | null;
    currentPlanVersionId: string;
    activeMilestoneNodeId: string | null;
    lockVersion: number;
    startedAt: string | null;
    endedAt: string | null;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  members: TaskMemberSummary[];
  tags: Array<{ id: string; name: string; color: string; isArchived: boolean }>;
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

export async function listTasks({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input?: {
    status?: TaskStatus;
    priority?: TaskPriority;
    mine?: boolean;
    query?: string;
    cursor?: string;
    limit?: number;
  };
}): Promise<TaskListResult> {
  const limit = Math.min(Math.max(input?.limit ?? 30, 1), 100);
  const query = normalizeSearchText(input?.query ?? "");
  const filters: Prisma.TaskWhereInput[] = [
    taskReadableWhere(actor),
    input?.status ? { status: input.status } : {},
    input?.priority ? { priority: input.priority } : {},
    input?.mine
      ? { members: { some: { personId: actor.personId, removedAt: null } } }
      : {},
  ];
  const where: Prisma.TaskWhereInput = { AND: filters };
  let hasMoreByQuery = false;
  let hasNextPage = false;
  let visibleTasks: Prisma.TaskGetPayload<{ include: typeof taskListInclude }>[];
  if (query) {
    const candidateSelect = { id: true, title: true, description: true, status: true } as const;
    const directCandidates = await prisma.task.findMany({
      where: {
        AND: [
          where,
          ...searchTerms(query).map((term) => ({
            OR: [
              { title: { contains: term, mode: "insensitive" as const } },
              { description: { contains: term, mode: "insensitive" as const } },
            ],
          })),
        ],
      },
      select: candidateSelect,
      orderBy: [{ title: "asc" }, { id: "asc" }],
      take: 501,
    });
    const fallbackCandidates = directCandidates.length < 50
      ? await prisma.task.findMany({
          where,
          select: candidateSelect,
          orderBy: [{ title: "asc" }, { id: "asc" }],
          take: 501,
        })
      : [];
    const candidates = [...new Map(
      [...directCandidates, ...fallbackCandidates].map((task) => [task.id, task]),
    ).values()];
    const ranked = rankFuzzyMatches(
      candidates,
      query,
      (task) => [
        { text: task.title, weight: 2, pinyin: true },
        { text: task.description, weight: 1 },
      ],
      (left, right) =>
        Number(right.status === "ACTIVE") - Number(left.status === "ACTIVE") ||
        left.title.localeCompare(right.title, "zh-CN") ||
        left.id.localeCompare(right.id),
    );
    const resultLimit = Math.min(limit, 50);
    const orderedIds = ranked.slice(0, resultLimit).map(({ item }) => item.id);
    const rows = orderedIds.length
      ? await prisma.task.findMany({
          where: { AND: [where, { id: { in: orderedIds } }] },
          include: taskListInclude,
        })
      : [];
    const byId = new Map(rows.map((task) => [task.id, task]));
    visibleTasks = orderedIds.flatMap((id) => {
      const task = byId.get(id);
      return task ? [task] : [];
    });
    hasMoreByQuery =
      ranked.length > resultLimit ||
      directCandidates.length === 501 ||
      fallbackCandidates.length === 501;
  } else {
    const tasks = await prisma.task.findMany({
      where,
      include: taskListInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    visibleTasks = tasks.slice(0, limit);
    hasNextPage = tasks.length > limit;
  }
  return {
    items: visibleTasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      team: task.team,
      techGroup: task.techGroup,
      status: task.status,
      priority: task.priority,
      currentPlanVersionNo: task.currentPlanVersion.versionNo,
      lockVersion: task.lockVersion,
      activeMilestone:
        task.activeMilestoneNode?.milestone
          ? {
              nodeId: task.activeMilestoneNode.id,
              goal: task.activeMilestoneNode.milestone.goal,
              expectedCompletedAt:
                task.activeMilestoneNode.milestone.expectedCompletedAt.toISOString(),
            }
          : null,
      activeTermination: task.currentPlanVersion.nodes[0]?.node.termination
        ? {
            nodeId: task.currentPlanVersion.nodes[0].node.id,
            name: task.currentPlanVersion.nodes[0].node.termination.name,
            plannedAt:
              task.currentPlanVersion.nodes[0].node.termination.plannedAt.toISOString(),
          }
        : null,
      members: task.members.map((member) => ({
        personId: member.personId,
        role: member.role,
        displayName: member.person.displayName,
      })),
      tags: task.tags.map((entry) => entry.tag),
      updatedAt: task.updatedAt.toISOString(),
      createdAt: task.createdAt.toISOString(),
    })),
    nextCursor: hasNextPage ? visibleTasks.at(-1)?.id ?? null : null,
    hasMoreByQuery,
  };
}

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
        include: { tag: { select: { id: true, name: true, color: true, archivedAt: true } } },
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
      relatedTaskId: task.relatedTaskId,
      currentPlanVersionId: task.currentPlanVersionId,
      activeMilestoneNodeId: task.activeMilestoneNodeId,
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
    tags: task.tags.map((entry) => ({
      id: entry.tag.id,
      name: entry.tag.name,
      color: entry.tag.color,
      isArchived: entry.tag.archivedAt !== null,
    })),
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

function serializePlanVersion(plan: PlanVersionWithNodes): PlanVersionSummary {
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

function taskResource(input: {
  team: string;
  techGroup: string;
  status: TaskStatus;
  priority: TaskPriority;
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
