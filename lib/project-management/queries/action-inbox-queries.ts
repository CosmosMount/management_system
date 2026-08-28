import type { Prisma, TaskNodeStatus, TaskNodeType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import {
  authorize,
  isSystemAdministrator,
  segmentReadableWhere,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import { validationError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { terminationOutcomeLabel } from "@/lib/project-management/notifications/user-facing-copy";
import {
  decodeActionInboxCursor,
  encodeActionInboxCursor,
  type ActionInboxCursorPosition,
  type ActionInboxCursorPositions,
  type ActionInboxStream,
} from "@/lib/project-management/queries/action-inbox-cursor";
import { actionInboxPageInputSchema } from "@/lib/project-management/validations/action-inbox";

export type ActionInboxKind =
  | "SEGMENT_CONFIRMATION"
  | "TASK_NEXT_NODE"
  | "MILESTONE_REVIEW"
  | "REVISION_REVIEW"
  | "PROJECT_ESTABLISHMENT"
  | "TERMINATION_REVIEW";

export type ActionInboxSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type ActionInboxItem = {
  id: string;
  kind: ActionInboxKind;
  title: string;
  summary: string;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  nodeId: string | null;
  nodeType: TaskNodeType | null;
  nodeStatus: TaskNodeStatus | null;
  relevantAt: string;
  timeLabel: string;
  severity: ActionInboxSeverity;
  href: string;
  actionLabel: string;
};

export type ActionInboxPage = {
  items: ActionInboxItem[];
  totalCount: number;
  criticalCount: number;
  nextCursor: string | null;
  generatedAt: string;
};

type StreamItem = {
  stream: ActionInboxStream;
  rawId: string;
  relevantAt: Date;
  item: ActionInboxItem;
};

const taskResourceSelect = {
  id: true,
  title: true,
  team: true,
  techGroup: true,
  status: true,
  priority: true,
  project: { select: { id: true, name: true } },
  members: {
    where: { removedAt: null },
    select: { personId: true, role: true, removedAt: true },
  },
} satisfies Prisma.TaskSelect;

export async function getActionInbox({
  actor,
  input,
  now = new Date(),
}: {
  actor: ProjectManagementActor;
  input?: unknown;
  now?: Date;
}): Promise<ActionInboxPage> {
  const parsed = actionInboxPageInputSchema.parse(input ?? {});
  if (actor.isActive === false) {
    return emptyActionInboxPage(now);
  }

  const cursor = parsed.cursor
    ? decodeActionInboxCursor(parsed.cursor, actor)
    : null;
  if (parsed.cursor && !cursor) throw invalidCursorError();
  const generatedAt = cursor ? new Date(cursor.generatedAt) : now;
  const positions = cursor?.positions ?? {};
  const visibleTask = taskReadableWhere(actor);
  const reviewableTask = isSystemAdministrator(actor)
    ? { deletedAt: null }
    : { id: { in: [] } };
  const participatingActiveTask: Prisma.TaskWhereInput = {
    deletedAt: null,
    status: "ACTIVE",
    members: {
      some: {
        personId: actor.personId,
        role: { in: ["OWNER", "PARTICIPANT"] },
        removedAt: null,
      },
    },
  };
  const currentPlanNode: Prisma.TaskNodeWhereInput = {
    planVersionEntries: {
      some: {
        planVersion: {
          status: "CURRENT",
          currentForTask: { isNot: null },
        },
      },
    },
  };
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
  const nextMilestoneWhere: Prisma.TaskNodeWhereInput = {
    AND: [
      {
        deletedAt: null,
        type: "MILESTONE",
        status: "ACTIVE",
        activeForTask: { isNot: null },
        task: participatingActiveTask,
        milestone: {
          is: {
            reviews: {
              none: { result: "PENDING", revokedAt: null },
            },
          },
        },
      },
      currentPlanNode,
    ],
  };
  const nextTerminationWhere: Prisma.TaskNodeWhereInput = {
    AND: [
      {
        deletedAt: null,
        type: "TERMINATION",
        status: "ACTIVE",
        task: {
          AND: [participatingActiveTask, { activeMilestoneNodeId: null }],
        },
        termination: {
          is: {
            outcome: null,
            reviews: { none: { result: "PENDING" } },
          },
        },
      },
      currentPlanNode,
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
  const projectRequestWhere: Prisma.ProjectEstablishmentRequestWhereInput = {
    AND: [
      isSystemAdministrator(actor) ? {} : { id: { in: [] } },
      {
        status: "PENDING",
        project: { deletedAt: null, status: "PENDING_APPROVAL" },
      },
    ],
  };

  if (cursor) {
    await assertCursorAnchors({
      positions,
      confirmationSegmentWhere,
      nextMilestoneWhere,
      nextTerminationWhere,
      milestoneReviewWhere,
      revisionWhere,
      terminationReviewWhere,
      projectRequestWhere,
    });
  }

  const segmentPosition = positions.SEGMENT_CONFIRMATION;
  const nextNodePosition = positions.TASK_NEXT_NODE;
  const milestoneReviewPosition = positions.MILESTONE_REVIEW;
  const revisionPosition = positions.REVISION_REVIEW;
  const projectPosition = positions.PROJECT_ESTABLISHMENT;
  const terminationReviewPosition = positions.TERMINATION_REVIEW;
  const segmentAfter = segmentPosition ? positionDate(segmentPosition) : null;
  const nextNodeAfter = nextNodePosition
    ? positionDate(nextNodePosition)
    : null;
  const milestoneReviewAfter = milestoneReviewPosition
    ? positionDate(milestoneReviewPosition)
    : null;
  const revisionAfter = revisionPosition
    ? positionDate(revisionPosition)
    : null;
  const projectAfter = projectPosition ? positionDate(projectPosition) : null;
  const terminationReviewAfter = terminationReviewPosition
    ? positionDate(terminationReviewPosition)
    : null;
  const take = parsed.limit + 1;

  const [
    confirmationSegments,
    nextMilestones,
    nextTerminations,
    reviews,
    revisions,
    terminationReviews,
    projectRequests,
    counts,
    criticalCounts,
  ] = await Promise.all([
    prisma.workSegment.findMany({
      where: {
        AND: [
          confirmationSegmentWhere,
          segmentPosition && segmentAfter
            ? {
                OR: [
                  { endAt: { gt: segmentAfter } },
                  { endAt: segmentAfter, id: { gt: segmentPosition.id } },
                ],
              }
            : {},
        ],
      },
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
      take,
    }),
    prisma.taskNode.findMany({
      where: {
        AND: [
          nextMilestoneWhere,
          nextNodePosition && nextNodeAfter
            ? {
                OR: [
                  {
                    milestone: {
                      is: { expectedCompletedAt: { gt: nextNodeAfter } },
                    },
                  },
                  {
                    milestone: { is: { expectedCompletedAt: nextNodeAfter } },
                    id: { gt: nextNodePosition.id },
                  },
                ],
              }
            : {},
        ],
      },
      select: {
        id: true,
        status: true,
        businessDescription: true,
        task: { select: taskResourceSelect },
        milestone: {
          select: {
            goal: true,
            completionCriteria: true,
            expectedCompletedAt: true,
          },
        },
      },
      orderBy: [{ milestone: { expectedCompletedAt: "asc" } }, { id: "asc" }],
      take,
    }),
    prisma.taskNode.findMany({
      where: {
        AND: [
          nextTerminationWhere,
          nextNodePosition && nextNodeAfter
            ? {
                OR: [
                  { termination: { is: { plannedAt: { gt: nextNodeAfter } } } },
                  {
                    termination: { is: { plannedAt: nextNodeAfter } },
                    id: { gt: nextNodePosition.id },
                  },
                ],
              }
            : {},
        ],
      },
      select: {
        id: true,
        status: true,
        businessDescription: true,
        task: { select: taskResourceSelect },
        termination: {
          select: {
            name: true,
            plannedOutcomeCriteria: true,
            plannedAt: true,
          },
        },
      },
      orderBy: [{ termination: { plannedAt: "asc" } }, { id: "asc" }],
      take,
    }),
    prisma.milestoneReview.findMany({
      where: {
        AND: [
          milestoneReviewWhere,
          milestoneReviewPosition && milestoneReviewAfter
            ? {
                OR: [
                  {
                    milestoneNode: {
                      expectedCompletedAt: { gt: milestoneReviewAfter },
                    },
                  },
                  {
                    milestoneNode: {
                      expectedCompletedAt: milestoneReviewAfter,
                    },
                    id: { gt: milestoneReviewPosition.id },
                  },
                ],
              }
            : {},
        ],
      },
      select: {
        id: true,
        milestoneNode: {
          select: {
            goal: true,
            expectedCompletedAt: true,
            node: {
              select: {
                id: true,
                status: true,
                task: { select: taskResourceSelect },
              },
            },
          },
        },
      },
      orderBy: [
        { milestoneNode: { expectedCompletedAt: "asc" } },
        { id: "asc" },
      ],
      take,
    }),
    prisma.revisionNode.findMany({
      where: {
        AND: [
          revisionWhere,
          revisionPosition && revisionAfter
            ? {
                OR: [
                  { revisionAt: { gt: revisionAfter } },
                  {
                    revisionAt: revisionAfter,
                    id: { gt: revisionPosition.id },
                  },
                ],
              }
            : {},
        ],
      },
      select: {
        id: true,
        reason: true,
        revisionAt: true,
        node: {
          select: {
            id: true,
            status: true,
            task: { select: taskResourceSelect },
          },
        },
      },
      orderBy: [{ revisionAt: "asc" }, { id: "asc" }],
      take,
    }),
    prisma.terminationReview.findMany({
      where: {
        AND: [
          terminationReviewWhere,
          terminationReviewPosition && terminationReviewAfter
            ? {
                OR: [
                  {
                    terminationNode: {
                      plannedAt: { gt: terminationReviewAfter },
                    },
                  },
                  {
                    terminationNode: { plannedAt: terminationReviewAfter },
                    id: { gt: terminationReviewPosition.id },
                  },
                ],
              }
            : {},
        ],
      },
      select: {
        id: true,
        outcome: true,
        reason: true,
        terminationNode: {
          select: {
            name: true,
            plannedAt: true,
            node: {
              select: {
                id: true,
                status: true,
                task: { select: taskResourceSelect },
              },
            },
          },
        },
      },
      orderBy: [{ terminationNode: { plannedAt: "asc" } }, { id: "asc" }],
      take,
    }),
    prisma.projectEstablishmentRequest.findMany({
      where: {
        AND: [
          projectRequestWhere,
          projectPosition && projectAfter
            ? {
                OR: [
                  { submittedAt: { gt: projectAfter } },
                  {
                    submittedAt: projectAfter,
                    id: { gt: projectPosition.id },
                  },
                ],
              }
            : {},
        ],
      },
      select: {
        id: true,
        round: true,
        submittedAt: true,
        project: { select: { id: true, name: true } },
      },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      take,
    }),
    Promise.all([
      prisma.workSegment.count({ where: confirmationSegmentWhere }),
      prisma.taskNode.count({ where: nextMilestoneWhere }),
      prisma.taskNode.count({ where: nextTerminationWhere }),
      prisma.milestoneReview.count({ where: milestoneReviewWhere }),
      prisma.revisionNode.count({ where: revisionWhere }),
      prisma.terminationReview.count({ where: terminationReviewWhere }),
      prisma.projectEstablishmentRequest.count({ where: projectRequestWhere }),
    ]),
    Promise.all([
      prisma.taskNode.count({
        where: {
          AND: [
            nextMilestoneWhere,
            { milestone: { is: { expectedCompletedAt: { lt: generatedAt } } } },
          ],
        },
      }),
      prisma.taskNode.count({
        where: {
          AND: [
            nextTerminationWhere,
            { termination: { is: { plannedAt: { lt: generatedAt } } } },
          ],
        },
      }),
      prisma.milestoneReview.count({
        where: {
          AND: [
            milestoneReviewWhere,
            { milestoneNode: { expectedCompletedAt: { lt: generatedAt } } },
          ],
        },
      }),
      prisma.terminationReview.count({
        where: {
          AND: [
            terminationReviewWhere,
            { terminationNode: { plannedAt: { lt: generatedAt } } },
          ],
        },
      }),
    ]),
  ]);

  const candidates: StreamItem[] = [];
  for (const segment of confirmationSegments) {
    const task = segment.task;
    const resource = task
      ? ({ type: "task", ...task } satisfies AuthorizationTaskResource)
      : null;
    const canManage = authorize({
      actor,
      action:
        segment.personId === actor.personId
          ? "segment.manage_self"
          : "segment.manage_others",
      resource: { type: "segment", personId: segment.personId, task: resource },
    }).allowed;
    if (!canManage) continue;
    candidates.push(
      streamItem("SEGMENT_CONFIRMATION", segment.id, segment.endAt, {
        id: `segment-confirm:${segment.id}`,
        kind: "SEGMENT_CONFIRMATION",
        title: segment.content,
        summary: "计划投入已到期，请确认完整、部分或未执行。",
        ...(task
          ? taskContext(task)
          : {
              projectId: null,
              projectName: null,
              taskId: null,
              taskTitle: null,
            }),
        nodeId: null,
        nodeType: null,
        nodeStatus: null,
        relevantAt: segment.endAt.toISOString(),
        timeLabel: "投入结束",
        severity: segment.endAt < generatedAt ? "HIGH" : "MEDIUM",
        href: `/progress?focus=${segment.id}`,
        actionLabel: "确认投入",
      }),
    );
  }

  const nextNodeCandidates: StreamItem[] = [];
  for (const node of nextMilestones) {
    if (!node.milestone) continue;
    nextNodeCandidates.push(
      streamItem(
        "TASK_NEXT_NODE",
        node.id,
        node.milestone.expectedCompletedAt,
        {
          id: `task-next-node:${node.id}`,
          kind: "TASK_NEXT_NODE",
          title: node.milestone.goal,
          summary: `完成标准：${node.milestone.completionCriteria}`,
          ...taskContext(node.task),
          nodeId: node.id,
          nodeType: "MILESTONE",
          nodeStatus: node.status,
          relevantAt: node.milestone.expectedCompletedAt.toISOString(),
          timeLabel: "计划完成",
          severity:
            node.milestone.expectedCompletedAt < generatedAt
              ? "CRITICAL"
              : "MEDIUM",
          href: `${routes.progress.taskDetail(node.task.id)}?focus=${node.id}`,
          actionLabel: "查看节点",
        },
      ),
    );
  }
  for (const node of nextTerminations) {
    if (!node.termination) continue;
    const nodeName = terminalName(node.termination.name);
    nextNodeCandidates.push(
      streamItem("TASK_NEXT_NODE", node.id, node.termination.plannedAt, {
        id: `task-next-node:${node.id}`,
        kind: "TASK_NEXT_NODE",
        title: nodeName,
        summary: `计划结束标准：${node.termination.plannedOutcomeCriteria}`,
        ...taskContext(node.task),
        nodeId: node.id,
        nodeType: "TERMINATION",
        nodeStatus: node.status,
        relevantAt: node.termination.plannedAt.toISOString(),
        timeLabel: "计划结束",
        severity:
          node.termination.plannedAt < generatedAt ? "CRITICAL" : "MEDIUM",
        href: `${routes.progress.taskDetail(node.task.id)}?focus=${node.id}`,
        actionLabel: "查看节点",
      }),
    );
  }
  nextNodeCandidates.sort(compareStreamItems);
  candidates.push(...nextNodeCandidates.slice(0, take));

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
    candidates.push(
      streamItem(
        "MILESTONE_REVIEW",
        review.id,
        review.milestoneNode.expectedCompletedAt,
        {
          id: `review:${review.id}`,
          kind: "MILESTONE_REVIEW",
          title: review.milestoneNode.goal,
          summary: "里程碑已提交验收，请给出审核决定。",
          ...taskContext(task),
          nodeId: review.milestoneNode.node.id,
          nodeType: "MILESTONE",
          nodeStatus: review.milestoneNode.node.status,
          relevantAt: review.milestoneNode.expectedCompletedAt.toISOString(),
          timeLabel: "计划完成",
          severity:
            review.milestoneNode.expectedCompletedAt < generatedAt
              ? "CRITICAL"
              : "HIGH",
          href: routes.progress.taskReviews(task.id),
          actionLabel: "审批验收",
        },
      ),
    );
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
    candidates.push(
      streamItem("REVISION_REVIEW", revision.id, revision.revisionAt, {
        id: `revision:${revision.id}`,
        kind: "REVISION_REVIEW",
        title: task.title,
        summary: revision.reason || "任务计划修订等待审核。",
        ...taskContext(task),
        nodeId: revision.node.id,
        nodeType: "REVISION",
        nodeStatus: revision.node.status,
        relevantAt: revision.revisionAt.toISOString(),
        timeLabel: "修订时间",
        severity: "HIGH",
        href: routes.progress.taskRevisions(task.id),
        actionLabel: "审核修订",
      }),
    );
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
    const nodeName = terminalName(review.terminationNode.name);
    candidates.push(
      streamItem(
        "TERMINATION_REVIEW",
        review.id,
        review.terminationNode.plannedAt,
        {
          id: `termination-review:${review.id}`,
          kind: "TERMINATION_REVIEW",
          title: task.title,
          summary: `${nodeName}申请${terminationOutcomeLabel(review.outcome)}，等待审批${review.reason ? `：${review.reason}` : ""}`,
          ...taskContext(task),
          nodeId: review.terminationNode.node.id,
          nodeType: "TERMINATION",
          nodeStatus: review.terminationNode.node.status,
          relevantAt: review.terminationNode.plannedAt.toISOString(),
          timeLabel: "计划结束",
          severity:
            review.terminationNode.plannedAt < generatedAt
              ? "CRITICAL"
              : "HIGH",
          href: `${routes.progress.taskDetail(task.id)}?focus=${review.terminationNode.node.id}`,
          actionLabel: "审批结束",
        },
      ),
    );
  }
  for (const request of projectRequests) {
    candidates.push(
      streamItem("PROJECT_ESTABLISHMENT", request.id, request.submittedAt, {
        id: `project-establishment:${request.id}`,
        kind: "PROJECT_ESTABLISHMENT",
        title: request.project.name,
        summary: `第 ${request.round} 轮项目立项申请等待审批。`,
        projectId: request.project.id,
        projectName: request.project.name,
        taskId: null,
        taskTitle: null,
        nodeId: null,
        nodeType: null,
        nodeStatus: null,
        relevantAt: request.submittedAt.toISOString(),
        timeLabel: "提交时间",
        severity: "HIGH",
        href: `${routes.progress.projectDetail(request.project.id)}#establishment`,
        actionLabel: "审批立项",
      }),
    );
  }

  candidates.sort(compareStreamItems);
  const pageItems = candidates.slice(0, parsed.limit);
  const nextPositions: ActionInboxCursorPositions = { ...positions };
  for (const candidate of pageItems) {
    nextPositions[candidate.stream] = {
      relevantAt: candidate.relevantAt.toISOString(),
      id: candidate.rawId,
    };
  }
  return {
    items: pageItems.map((candidate) => candidate.item),
    totalCount: counts.reduce((sum, count) => sum + count, 0),
    criticalCount: criticalCounts.reduce((sum, count) => sum + count, 0),
    nextCursor:
      candidates.length > parsed.limit
        ? encodeActionInboxCursor(actor, generatedAt, nextPositions)
        : null,
    generatedAt: generatedAt.toISOString(),
  };
}

function streamItem(
  stream: ActionInboxStream,
  rawId: string,
  relevantAt: Date,
  item: ActionInboxItem,
): StreamItem {
  return { stream, rawId, relevantAt, item };
}

function taskContext(task: {
  id: string;
  title: string;
  project: { id: string; name: string } | null;
}) {
  return {
    projectId: task.project?.id ?? null,
    projectName: task.project?.name ?? null,
    taskId: task.id,
    taskTitle: task.title,
  };
}

function terminalName(name: string) {
  return name === "Terminal" ? "结束节点" : name;
}

const severityRank: Record<ActionInboxSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function compareStreamItems(left: StreamItem, right: StreamItem) {
  return (
    severityRank[left.item.severity] - severityRank[right.item.severity] ||
    left.relevantAt.getTime() - right.relevantAt.getTime() ||
    left.item.id.localeCompare(right.item.id)
  );
}

function emptyActionInboxPage(now: Date): ActionInboxPage {
  return {
    items: [],
    totalCount: 0,
    criticalCount: 0,
    nextCursor: null,
    generatedAt: now.toISOString(),
  };
}

function invalidCursorError() {
  return validationError("分页游标无效或已不再匹配当前待办队列", {
    cursor: ["分页游标无效或已不再匹配当前待办队列"],
  });
}

function positionDate(position: ActionInboxCursorPosition) {
  const date = new Date(position.relevantAt);
  if (Number.isNaN(date.getTime())) throw invalidCursorError();
  return date;
}

async function assertCursorAnchors({
  positions,
  confirmationSegmentWhere,
  nextMilestoneWhere,
  nextTerminationWhere,
  milestoneReviewWhere,
  revisionWhere,
  terminationReviewWhere,
  projectRequestWhere,
}: {
  positions: ActionInboxCursorPositions;
  confirmationSegmentWhere: Prisma.WorkSegmentWhereInput;
  nextMilestoneWhere: Prisma.TaskNodeWhereInput;
  nextTerminationWhere: Prisma.TaskNodeWhereInput;
  milestoneReviewWhere: Prisma.MilestoneReviewWhereInput;
  revisionWhere: Prisma.RevisionNodeWhereInput;
  terminationReviewWhere: Prisma.TerminationReviewWhereInput;
  projectRequestWhere: Prisma.ProjectEstablishmentRequestWhereInput;
}) {
  const checks = await Promise.all([
    anchorExists(positions.SEGMENT_CONFIRMATION, (position, relevantAt) =>
      prisma.workSegment.findFirst({
        where: {
          AND: [
            confirmationSegmentWhere,
            { id: position.id, endAt: relevantAt },
          ],
        },
        select: { id: true },
      }),
    ),
    anchorExists(positions.TASK_NEXT_NODE, (position, relevantAt) =>
      prisma.taskNode.findFirst({
        where: {
          AND: [
            { OR: [nextMilestoneWhere, nextTerminationWhere] },
            { id: position.id },
            {
              OR: [
                { milestone: { is: { expectedCompletedAt: relevantAt } } },
                { termination: { is: { plannedAt: relevantAt } } },
              ],
            },
          ],
        },
        select: { id: true },
      }),
    ),
    anchorExists(positions.MILESTONE_REVIEW, (position, relevantAt) =>
      prisma.milestoneReview.findFirst({
        where: {
          AND: [
            milestoneReviewWhere,
            {
              id: position.id,
              milestoneNode: { expectedCompletedAt: relevantAt },
            },
          ],
        },
        select: { id: true },
      }),
    ),
    anchorExists(positions.REVISION_REVIEW, (position, relevantAt) =>
      prisma.revisionNode.findFirst({
        where: {
          AND: [revisionWhere, { id: position.id, revisionAt: relevantAt }],
        },
        select: { id: true },
      }),
    ),
    anchorExists(positions.PROJECT_ESTABLISHMENT, (position, relevantAt) =>
      prisma.projectEstablishmentRequest.findFirst({
        where: {
          AND: [
            projectRequestWhere,
            { id: position.id, submittedAt: relevantAt },
          ],
        },
        select: { id: true },
      }),
    ),
    anchorExists(positions.TERMINATION_REVIEW, (position, relevantAt) =>
      prisma.terminationReview.findFirst({
        where: {
          AND: [
            terminationReviewWhere,
            {
              id: position.id,
              terminationNode: { plannedAt: relevantAt },
            },
          ],
        },
        select: { id: true },
      }),
    ),
  ]);
  if (checks.some((exists) => !exists)) throw invalidCursorError();
}

async function anchorExists(
  position: ActionInboxCursorPosition | undefined,
  lookup: (
    position: ActionInboxCursorPosition,
    relevantAt: Date,
  ) => Promise<{ id: string } | null>,
) {
  if (!position) return true;
  return Boolean(await lookup(position, positionDate(position)));
}
