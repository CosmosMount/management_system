import type {
  Prisma,
  TaskMemberRole,
  TaskPriority,
  TaskStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authorize,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  loadTaskApprovalGate,
  type TaskPendingApproval,
} from "@/lib/project-management/task-approval-gate";
import { notFoundError } from "@/lib/project-management/application/errors";
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";
import {
  normalizeSearchText,
  searchTerms,
} from "@/lib/search/normalize-search-text";
import { validationError } from "@/lib/project-management/application/errors";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "@/lib/project-management/queries/keyset-cursor";
import { inspectRevisionTargetStructure } from "@/lib/project-management/domain/revision-target-structure";
import {
  planVersionInclude,
  serializePlanVersion,
  taskResource,
  toIso,
  type PlanVersionSummary,
  type PlanVersionWithNodes,
} from "@/lib/project-management/queries/task-plan-queries";

export {
  comparePlanVersions,
  getMilestoneCompletionDetails,
  getPlanVersion,
  getRevisionBasePlan,
  listTaskPlanVersions,
  type MilestoneCompletionDetails,
  type PlanVersionDiff,
  type PlanVersionSummary,
  type RevisionBasePlanDetails,
} from "@/lib/project-management/queries/task-plan-queries";

export type TaskListItem = {
  id: string;
  title: string;
  description: string;
  team: string;
  techGroup: string;
  status: TaskStatus;
  priority: TaskPriority;
  project: { id: string; name: string; avatarPath: string | null } | null;
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
  updatedAt: string;
  createdAt: string;
};

export type TaskListResult = {
  items: TaskListItem[];
  nextCursor: string | null;
  hasMoreByQuery: boolean;
};

const taskListInclude = {
  project: { select: { id: true, name: true, avatarPath: true } },
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
} satisfies Prisma.TaskInclude;

type TaskMemberSummary = {
  personId: string;
  role: TaskMemberRole;
  displayName: string;
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
    projectId: string | null;
    project: { id: string; name: string; avatarPath: string | null } | null;
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
  currentPlan: PlanVersionSummary;
  pendingApproval: TaskPendingApproval | null;
  pendingApprovalConflict: boolean;
  pendingRevisionPlanComparison: PendingRevisionPlanComparison | null;
  permissions: {
    canUpdateMetadata: boolean;
    canManageMembers: boolean;
    canActivate: boolean;
    canDeleteDraft: boolean;
    canCreateRevision: boolean;
    canSubmitMilestoneReview: boolean;
    canReviewMilestone: boolean;
    canSubmitTerminationReview: boolean;
    canReviewTermination: boolean;
    canViewHistory: boolean;
  };
};

export type PendingRevisionPlanComparison =
  | {
      status: "READY";
      revisionNodeId: string;
      revisionReason: string;
      revisionAt: string;
      plan: PlanVersionSummary;
    }
  | {
      status: "UNAVAILABLE";
      revisionNodeId: string;
      message: string;
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
      ? {
          OR: [
            {
              members: {
                some: { personId: actor.personId, removedAt: null },
              },
            },
            { status: "DRAFT", createdByAccountId: actor.accountId },
          ],
        }
      : {},
  ];
  const where: Prisma.TaskWhereInput = { AND: filters };
  const cursorScope = JSON.stringify({
    accountId: actor.accountId,
    status: input?.status ?? null,
    priority: input?.priority ?? null,
    mine: input?.mine ?? false,
  });
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
    const cursor = decodeKeysetCursor(
      input?.cursor,
      "TASK",
      cursorScope,
      "Task 分页游标无效",
    );
    if (cursor) {
      const anchor = await prisma.task.findFirst({
        where: {
          AND: [where, { id: cursor.id, updatedAt: cursor.timestamp }],
        },
        select: { id: true },
      });
      if (!anchor) throw validationError("Task 分页游标无效");
    }
    const tasks = await prisma.task.findMany({
      where: {
        AND: [
          where,
          cursor
            ? {
                OR: [
                  { updatedAt: { lt: cursor.timestamp } },
                  { updatedAt: cursor.timestamp, id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      include: taskListInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
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
      project: task.project,
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
      updatedAt: task.updatedAt.toISOString(),
      createdAt: task.createdAt.toISOString(),
    })),
    nextCursor: hasNextPage
      ? encodeKeysetCursor(
          "TASK",
          cursorScope,
          visibleTasks.at(-1)
            ? {
                timestamp: visibleTasks.at(-1)!.updatedAt,
                id: visibleTasks.at(-1)!.id,
              }
            : undefined,
        )
      : null,
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
      project: { select: { id: true, name: true, avatarPath: true } },
      members: {
        where: { removedAt: null },
        include: { person: { select: { displayName: true } } },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      },
      currentPlanVersion: {
        include: planVersionInclude,
      },
    },
  });
  if (!task) throw notFoundError();

  const approvalGate = await loadTaskApprovalGate(prisma, task.id);
  const pendingRevisionPlanComparison =
    !approvalGate.pendingApprovalConflict &&
    approvalGate.pendingApproval?.kind === "REVISION"
      ? await loadPendingRevisionPlanComparison({
          taskId: task.id,
          currentPlanVersionId: task.currentPlanVersionId,
          currentPlan: task.currentPlanVersion,
          lockVersion: task.lockVersion,
          revisionNodeId: approvalGate.pendingApproval.id,
        })
      : null;

  const resource = taskResource({
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    priority: task.priority,
    createdByAccountId: task.createdByAccountId,
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
    projectId: task.projectId,
    project: task.project,
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
    currentPlan: serializePlanVersion(task.currentPlanVersion),
    pendingApproval: approvalGate.pendingApproval,
    pendingApprovalConflict: approvalGate.pendingApprovalConflict,
    pendingRevisionPlanComparison,
    permissions: {
      canUpdateMetadata: allowed(actor, "task.update_metadata", resource),
      canManageMembers: allowed(actor, "task.manage_members", resource),
      canActivate: allowed(actor, "task.activate", resource),
      canDeleteDraft: allowed(actor, "task.delete", resource),
      canCreateRevision: allowed(actor, "revision.create", resource),
      canSubmitMilestoneReview: allowed(
        actor,
        "milestone.submit_review",
        resource,
      ),
      canReviewMilestone: allowed(actor, "milestone.review", resource),
      canSubmitTerminationReview: allowed(
        actor,
        "termination.submit_review",
        resource,
      ),
      canReviewTermination: allowed(actor, "termination.review", resource),
      canViewHistory: allowed(actor, "plan.view_history", resource),
    },
  };
}

async function loadPendingRevisionPlanComparison({
  taskId,
  currentPlanVersionId,
  currentPlan,
  lockVersion,
  revisionNodeId,
}: {
  taskId: string;
  currentPlanVersionId: string;
  currentPlan: PlanVersionWithNodes;
  lockVersion: number;
  revisionNodeId: string;
}): Promise<PendingRevisionPlanComparison> {
  const unavailable = (message: string): PendingRevisionPlanComparison => ({
    status: "UNAVAILABLE",
    revisionNodeId,
    message,
  });
  const revision = await prisma.revisionNode.findFirst({
    where: {
      id: revisionNodeId,
      status: "PENDING_APPROVAL",
      node: { taskId, deletedAt: null },
    },
    select: {
      id: true,
      nodeId: true,
      reason: true,
      revisionAt: true,
      basePlanVersionId: true,
      baseTaskLockVersion: true,
      targetPlanVersion: { include: planVersionInclude },
    },
  });
  if (!revision) {
    return unavailable("待审批 Revision 已变化，无法安全展示修改后计划。");
  }
  if (
    revision.basePlanVersionId !== currentPlanVersionId ||
    revision.baseTaskLockVersion !== lockVersion
  ) {
    return unavailable("待审批 Revision 的基线已失效，无法安全展示修改后计划。");
  }

  const targetPlan = revision.targetPlanVersion;
  if (!targetPlan) {
    return unavailable("待审批 Revision 缺少修改后的候选计划。");
  }
  if (
    targetPlan.taskId !== taskId ||
    targetPlan.status !== "DRAFT" ||
    targetPlan.baseVersionId !== revision.basePlanVersionId ||
    targetPlan.revisionNodeId !== revision.id ||
    targetPlan.nodes.some(
      (entry) => entry.node.taskId !== taskId || entry.node.deletedAt !== null,
    )
  ) {
    return unavailable("待审批 Revision 的候选计划关联异常，无法安全展示修改后计划。");
  }

  const serializedTargetPlan = serializePlanVersion(targetPlan);
  if (
    serializedTargetPlan.chronologyCompatibilityIssues.length > 0 ||
    inspectRevisionTargetStructure({
      basePlan: currentPlan,
      targetPlan,
      targetPlanVersionId: targetPlan.id,
      revisionId: revision.id,
      revisionTaskNodeId: revision.nodeId,
    }).length > 0
  ) {
    return unavailable("待审批 Revision 的候选计划结构异常，无法安全展示修改后计划。");
  }

  return {
    status: "READY",
    revisionNodeId: revision.id,
    revisionReason: revision.reason,
    revisionAt: revision.revisionAt.toISOString(),
    plan: serializedTargetPlan,
  };
}

function allowed(
  actor: ProjectManagementActor,
  action: Parameters<typeof authorize>[0]["action"],
  resource: AuthorizationTaskResource,
): boolean {
  return authorize({ actor, action, resource }).allowed;
}
