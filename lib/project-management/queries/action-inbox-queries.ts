import type {
  Prisma,
  TaskMemberRole,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import {
  authorize,
  isSystemAdministrator,
  segmentReadableWhere,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { terminationOutcomeLabel } from "@/lib/project-management/notifications/user-facing-copy";

export type ActionInboxKind =
  | "SEGMENT_CONFIRMATION"
  | "MILESTONE_REVIEW"
  | "REVISION_REVIEW"
  | "PROJECT_ESTABLISHMENT"
  | "TERMINATION"
  | "TERMINATION_REVIEW";

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
  const reviewableTask = isSystemAdministrator(actor)
    ? { deletedAt: null }
    : { id: { in: [] } };
  const terminableTask = taskActionableWhere(actor, ["OWNER", "PARTICIPANT"]);
  const confirmationSegmentWhere: Prisma.WorkSegmentWhereInput = {
    AND: [
      segmentReadableWhere(actor),
      {
        personId: actor.personId,
        type: "PLANNED",
        status: "PENDING_CONFIRMATION",
      },
      isSystemAdministrator(actor)
        ? {}
        : {
            OR: [
              { taskId: null },
              {
                task: {
                  members: {
                    some: {
                      personId: actor.personId,
                      role: { in: ["OWNER", "PARTICIPANT"] },
                      removedAt: null,
                    },
                  },
                },
              },
            ],
          },
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
  const terminationReviewWhere: Prisma.TerminationReviewWhereInput = {
    result: "PENDING",
    terminationNode: {
      node: {
        task: { AND: [visibleTask, reviewableTask] },
        planVersionEntries: {
          some: { planVersion: { currentForTask: { isNot: null } } },
        },
      },
    },
  };
  const terminationWhere: Prisma.TerminationNodeWhereInput = {
    outcome: null,
    node: {
      status: { in: ["PENDING", "ACTIVE"] },
      task: {
        AND: [
          visibleTask,
          terminableTask,
          { status: "ACTIVE" },
          {
            nodes: {
              none: {
                OR: [
                  {
                    milestone: {
                      is: {
                        reviews: {
                          some: { result: "PENDING", revokedAt: null },
                        },
                      },
                    },
                  },
                  { revision: { is: { status: "PENDING_APPROVAL" } } },
                  {
                    termination: {
                      is: { reviews: { some: { result: "PENDING" } } },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      planVersionEntries: {
        some: { planVersion: { currentForTask: { isNot: null } } },
      },
    },
  };
  const [
    confirmationSegments,
    reviews,
    revisions,
    terminations,
    terminationReviews,
    projectRequests,
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
          task: { select: taskResourceSelect },
        },
        orderBy: [{ endAt: "asc" }, { id: "asc" }],
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
          revisionAt: true,
          node: {
            select: {
              createdByAccountId: true,
              task: { select: taskResourceSelect },
            },
          },
        },
        orderBy: [{ revisionAt: "asc" }, { id: "asc" }],
        take: boundedLimit,
      }),
      prisma.terminationNode.findMany({
        where: terminationWhere,
        select: {
          id: true,
          plannedAt: true,
          name: true,
          plannedOutcomeCriteria: true,
          node: { select: { id: true, task: { select: taskResourceSelect } } },
        },
        orderBy: [{ plannedAt: "asc" }, { id: "asc" }],
        take: boundedLimit,
      }),
      prisma.terminationReview.findMany({
        where: terminationReviewWhere,
        select: {
          id: true,
          outcome: true,
          reason: true,
          summary: true,
          createdAt: true,
          terminationNode: {
            select: {
              name: true,
              plannedAt: true,
              node: {
                select: { id: true, task: { select: taskResourceSelect } },
              },
            },
          },
        },
        orderBy: [{ terminationNode: { plannedAt: "asc" } }, { id: "asc" }],
        take: boundedLimit,
      }),
      isSystemAdministrator(actor)
        ? prisma.projectEstablishmentRequest.findMany({
            where: { status: "PENDING", project: { deletedAt: null, status: "PENDING_APPROVAL" } },
            select: { id: true, round: true, submittedAt: true, project: { select: { id: true, name: true } } },
            orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
            take: boundedLimit,
          })
        : Promise.resolve([]),
      Promise.all([
        prisma.workSegment.count({ where: confirmationSegmentWhere }),
        prisma.milestoneReview.count({ where: milestoneReviewWhere }),
        prisma.revisionNode.count({ where: revisionWhere }),
        prisma.terminationNode.count({ where: terminationWhere }),
        prisma.terminationReview.count({ where: terminationReviewWhere }),
        isSystemAdministrator(actor)
          ? prisma.projectEstablishmentRequest.count({ where: { status: "PENDING", project: { deletedAt: null, status: "PENDING_APPROVAL" } } })
          : Promise.resolve(0),
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
        prisma.terminationReview.count({
          where: {
            AND: [
              terminationReviewWhere,
              { terminationNode: { plannedAt: { lt: now } } },
            ],
          },
        }),
      ]),
    ]);

  const items: ActionInboxItem[] = [];
  for (const segment of confirmationSegments) {
    const task = segment.task;
    const resource = task ? ({ type: "task", ...task } satisfies AuthorizationTaskResource) : null;
    const canManage = authorize({
      actor,
      action:
        segment.personId === actor.personId
          ? "segment.manage_self"
          : "segment.manage_others",
      resource: { type: "segment", personId: segment.personId, task: resource },
    }).allowed;
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
        href: `/progress?focus=${segment.id}`,
      });
    }
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
      summary: "里程碑已提交验收，请给出审核决定。",
      taskId: task.id,
      taskTitle: task.title,
      dueAt: review.milestoneNode.expectedCompletedAt.toISOString(),
      severity: review.milestoneNode.expectedCompletedAt < now ? "CRITICAL" : "HIGH",
      href: routes.progress.taskReviews(task.id),
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
      summary: revision.reason || "任务计划修订等待审核。",
      taskId: task.id,
      taskTitle: task.title,
      dueAt: revision.revisionAt.toISOString(),
      severity: "HIGH",
      href: routes.progress.taskRevisions(task.id),
    });
  }
  for (const termination of terminations) {
    const task = termination.node.task;
    if (
      !authorize({ actor, action: "termination.submit_review", resource: { type: "task", ...task } })
        .allowed
    ) {
      continue;
    }
    items.push({
      id: `termination:${termination.id}`,
      kind: "TERMINATION",
      title: task.title,
      summary: `${termination.name === "Terminal" ? "结束节点" : termination.name}：${termination.plannedOutcomeCriteria}`,
      taskId: task.id,
      taskTitle: task.title,
      dueAt: termination.plannedAt.toISOString(),
      severity: termination.plannedAt < now ? "CRITICAL" : "MEDIUM",
      href: `/progress/tasks/${task.id}?focus=${termination.node.id}`,
    });
  }
  for (const review of terminationReviews) {
    const task = review.terminationNode.node.task;
    if (
      !authorize({
        actor,
        action: "termination.review",
        resource: { type: "task", ...task },
      }).allowed
    ) {
      continue;
    }
    const terminalName =
      review.terminationNode.name === "Terminal"
        ? "结束节点"
        : review.terminationNode.name;
    items.push({
      id: `termination-review:${review.id}`,
      kind: "TERMINATION_REVIEW",
      title: task.title,
      summary: `${terminalName}申请${terminationOutcomeLabel(review.outcome)}，等待审批${review.reason ? `：${review.reason}` : ""}`,
      taskId: task.id,
      taskTitle: task.title,
      dueAt: review.terminationNode.plannedAt.toISOString(),
      severity: review.terminationNode.plannedAt < now ? "CRITICAL" : "HIGH",
      href: `/progress/tasks/${task.id}?focus=${review.terminationNode.node.id}`,
    });
  }
  for (const request of projectRequests) {
    items.push({
      id: `project-establishment:${request.id}`,
      kind: "PROJECT_ESTABLISHMENT",
      title: request.project.name,
      summary: `第 ${request.round} 轮项目立项申请等待审批。`,
      taskId: null,
      taskTitle: null,
      dueAt: request.submittedAt.toISOString(),
      severity: "HIGH",
      href: `/progress/projects/${request.project.id}#establishment`,
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
