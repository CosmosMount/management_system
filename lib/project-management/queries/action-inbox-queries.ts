import type {
  Prisma,
  TaskMemberRole,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authorize,
  isSystemAdministrator,
  segmentReadableWhere,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

export type ActionInboxKind =
  | "SEGMENT_CONFIRMATION"
  | "MILESTONE_REVIEW"
  | "REVISION_REVIEW"
  | "TERMINATION"
  | "ASSOCIATION_REVIEW";

export type ActionInboxItem = {
  id: string;
  kind: ActionInboxKind;
  title: string;
  summary: string;
  taskId: string | null;
  taskTitle: string | null;
  dueAt: string | null;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  href: string;
};

const taskResourceSelect = {
  id: true,
  title: true,
  team: true,
  techGroup: true,
  status: true,
  priority: true,
  members: {
    where: { removedAt: null },
    select: { personId: true, role: true, removedAt: true },
  },
} satisfies Prisma.TaskSelect;

export async function getActionInbox({
  actor,
  limit = 100,
}: {
  actor: ProjectManagementActor;
  limit?: number;
}): Promise<{
  items: ActionInboxItem[];
  totalCount: number;
  criticalCount: number;
  generatedAt: string;
}> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const now = new Date();
  const visibleTask = taskReadableWhere(actor);
  const segmentManagerTask = taskActionableWhere(actor, ["OWNER"]);
  const reviewableTask = isSystemAdministrator(actor)
    ? { deletedAt: null }
    : { id: { in: [] } };
  const terminableTask = taskActionableWhere(actor, ["OWNER"]);
  const confirmationSegmentWhere: Prisma.WorkSegmentWhereInput = {
    AND: [
      segmentReadableWhere(actor),
      {
        personId: actor.personId,
        type: "PLANNED",
        status: "PENDING_CONFIRMATION",
      },
    ],
  };
  const associationSegmentWhere: Prisma.WorkSegmentWhereInput = {
    AND: [
      segmentReadableWhere(actor),
      { associationNeedsReview: true },
      isSystemAdministrator(actor)
        ? {}
        : { OR: [{ personId: actor.personId }, { task: segmentManagerTask }] },
    ],
  };
  const milestoneReviewWhere: Prisma.MilestoneReviewWhereInput = {
    result: "PENDING",
    revokedAt: null,
    milestoneNode: {
      node: {
        task: { AND: [visibleTask, reviewableTask] },
        planVersionEntries: {
          some: { planVersion: { currentForTask: { isNot: null } } },
        },
      },
    },
  };
  const revisionWhere: Prisma.RevisionNodeWhereInput = {
    status: "PENDING_APPROVAL",
    node: { task: { AND: [visibleTask, reviewableTask] } },
  };
  const terminationWhere: Prisma.TerminationNodeWhereInput = {
    outcome: null,
    node: {
      status: { in: ["PENDING", "ACTIVE"] },
      task: { AND: [visibleTask, terminableTask] },
      planVersionEntries: {
        some: { planVersion: { currentForTask: { isNot: null } } },
      },
    },
  };
  const [
    confirmationSegments,
    associationSegments,
    reviews,
    revisions,
    terminations,
    counts,
    criticalCounts,
  ] =
    await Promise.all([
      prisma.workSegment.findMany({
        where: confirmationSegmentWhere,
        select: {
          id: true,
          personId: true,
          type: true,
          status: true,
          content: true,
          endAt: true,
          associationNeedsReview: true,
          task: { select: taskResourceSelect },
        },
        orderBy: [{ endAt: "asc" }, { id: "asc" }],
        take: boundedLimit,
      }),
      prisma.workSegment.findMany({
        where: associationSegmentWhere,
        select: {
          id: true,
          personId: true,
          type: true,
          status: true,
          content: true,
          endAt: true,
          associationNeedsReview: true,
          task: { select: taskResourceSelect },
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: boundedLimit,
      }),
      prisma.milestoneReview.findMany({
        where: milestoneReviewWhere,
        select: {
          id: true,
          submittedByAccountId: true,
          createdAt: true,
          milestoneNode: {
            select: {
              goal: true,
              expectedCompletedAt: true,
              node: { select: { task: { select: taskResourceSelect } } },
            },
          },
        },
        orderBy: [
          { milestoneNode: { expectedCompletedAt: "asc" } },
          { id: "asc" },
        ],
        take: boundedLimit,
      }),
      prisma.revisionNode.findMany({
        where: revisionWhere,
        select: {
          id: true,
          reason: true,
          submittedAt: true,
          node: {
            select: {
              createdByAccountId: true,
              task: { select: taskResourceSelect },
            },
          },
        },
        orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
        take: boundedLimit,
      }),
      prisma.terminationNode.findMany({
        where: terminationWhere,
        select: {
          id: true,
          plannedAt: true,
          name: true,
          plannedOutcomeCriteria: true,
          node: { select: { task: { select: taskResourceSelect } } },
        },
        orderBy: [{ plannedAt: "asc" }, { id: "asc" }],
        take: boundedLimit,
      }),
      Promise.all([
        prisma.workSegment.count({ where: confirmationSegmentWhere }),
        prisma.workSegment.count({ where: associationSegmentWhere }),
        prisma.milestoneReview.count({ where: milestoneReviewWhere }),
        prisma.revisionNode.count({ where: revisionWhere }),
        prisma.terminationNode.count({ where: terminationWhere }),
      ]),
      Promise.all([
        prisma.milestoneReview.count({
          where: {
            AND: [
              milestoneReviewWhere,
              { milestoneNode: { expectedCompletedAt: { lt: now } } },
            ],
          },
        }),
        prisma.terminationNode.count({
          where: { AND: [terminationWhere, { plannedAt: { lt: now } }] },
        }),
      ]),
    ]);

  const items: ActionInboxItem[] = [];
  for (const segment of confirmationSegments) {
    const task = segment.task;
    const resource = task ? ({ type: "task", ...task } satisfies AuthorizationTaskResource) : null;
    const canManage =
      segment.personId === actor.personId ||
      (resource
        ? authorize({
            actor,
            action: "segment.manage_others",
            resource: { type: "segment", personId: segment.personId, task: resource },
          }).allowed
        : false);
    if (!canManage) continue;
    if (
      segment.personId === actor.personId &&
      segment.type === "PLANNED" &&
      segment.status === "PENDING_CONFIRMATION"
    ) {
      items.push({
        id: `segment-confirm:${segment.id}`,
        kind: "SEGMENT_CONFIRMATION",
        title: segment.content,
        summary: "计划投入已到期，请确认完整、部分或未执行。",
        taskId: task?.id ?? null,
        taskTitle: task?.title ?? null,
        dueAt: segment.endAt.toISOString(),
        severity: segment.endAt < now ? "HIGH" : "MEDIUM",
        href: `/progress/my-timeline?focus=${segment.id}`,
      });
    }
  }
  for (const segment of associationSegments) {
    const task = segment.task;
    items.push({
      id: `association:${segment.id}`,
      kind: "ASSOCIATION_REVIEW",
      title: segment.content,
      summary: "计划修订后关联可能失效，请重新确认 Task 与节点。",
      taskId: task?.id ?? null,
      taskTitle: task?.title ?? null,
      dueAt: null,
      severity: "HIGH",
      href: `/progress/resources?focus=${segment.id}`,
    });
  }
  for (const review of reviews) {
    const task = review.milestoneNode.node.task;
    if (
      !authorize({
        actor,
        action: "milestone.review",
        resource: { type: "task", ...task },
      }).allowed
    ) {
      continue;
    }
    items.push({
      id: `review:${review.id}`,
      kind: "MILESTONE_REVIEW",
      title: review.milestoneNode.goal,
      summary: "Milestone 已提交验收，请给出审核决定。",
      taskId: task.id,
      taskTitle: task.title,
      dueAt: review.milestoneNode.expectedCompletedAt.toISOString(),
      severity: review.milestoneNode.expectedCompletedAt < now ? "CRITICAL" : "HIGH",
      href: `/progress/tasks/${task.id}?tab=reviews`,
    });
  }
  for (const revision of revisions) {
    const task = revision.node.task;
    if (
      !authorize({
        actor,
        action: "revision.review",
        resource: { type: "task", ...task },
      }).allowed
    ) {
      continue;
    }
    items.push({
      id: `revision:${revision.id}`,
      kind: "REVISION_REVIEW",
      title: task.title,
      summary: revision.reason || "Task 计划修订等待审核。",
      taskId: task.id,
      taskTitle: task.title,
      dueAt: revision.submittedAt?.toISOString() ?? null,
      severity: "HIGH",
      href: `/progress/tasks/${task.id}?tab=revisions`,
    });
  }
  for (const termination of terminations) {
    const task = termination.node.task;
    if (
      !authorize({ actor, action: "task.terminate", resource: { type: "task", ...task } })
        .allowed
    ) {
      continue;
    }
    items.push({
      id: `termination:${termination.id}`,
      kind: "TERMINATION",
      title: task.title,
      summary: `${termination.name}：${termination.plannedOutcomeCriteria}`,
      taskId: task.id,
      taskTitle: task.title,
      dueAt: termination.plannedAt.toISOString(),
      severity: termination.plannedAt < now ? "CRITICAL" : "MEDIUM",
      href: `/progress/tasks/${task.id}?tab=reviews`,
    });
  }
  const severityRank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;
  items.sort((left, right) => {
    const severity = severityRank[left.severity] - severityRank[right.severity];
    if (severity !== 0) return severity;
    const leftDue = left.dueAt ? Date.parse(left.dueAt) : Number.MAX_SAFE_INTEGER;
    const rightDue = right.dueAt ? Date.parse(right.dueAt) : Number.MAX_SAFE_INTEGER;
    return leftDue - rightDue || left.id.localeCompare(right.id);
  });
  return {
    items: items.slice(0, boundedLimit),
    totalCount: counts.reduce((sum, count) => sum + count, 0),
    criticalCount: criticalCounts.reduce((sum, count) => sum + count, 0),
    generatedAt: now.toISOString(),
  };
}

function taskActionableWhere(
  actor: ProjectManagementActor,
  taskRoles: TaskMemberRole[],
): Prisma.TaskWhereInput {
  if (isSystemAdministrator(actor)) return { deletedAt: null };
  const roleWhere: Prisma.TaskWhereInput[] = taskRoles.length
    ? [
        {
          members: {
            some: {
              personId: actor.personId,
              removedAt: null,
              role: { in: taskRoles },
            },
          },
        },
      ]
    : [];
  return {
    deletedAt: null,
    OR: roleWhere,
  };
}
