import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentDeadlinePlanNodesSelect } from "@/lib/project-management/queries/current-node-deadline-select";
import type { ActionInboxCursorPositions } from "@/lib/project-management/queries/action-inbox-cursor";
import { positionDate } from "@/lib/project-management/queries/action-inbox-cursor-validation";

const taskResourceSelect = {
  activeMilestoneNodeId: true,
  currentPlanVersion: { select: { nodes: currentDeadlinePlanNodesSelect } },
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

export async function loadActionInboxSources({
  positions,
  generatedAt,
  take,
  nextMilestoneWhere,
  nextTerminationWhere,
  milestoneReviewWhere,
  revisionWhere,
  terminationReviewWhere,
  projectRequestWhere,
}: {
  positions: ActionInboxCursorPositions;
  generatedAt: Date;
  take: number;
  nextMilestoneWhere: Prisma.TaskNodeWhereInput;
  nextTerminationWhere: Prisma.TaskNodeWhereInput;
  milestoneReviewWhere: Prisma.MilestoneReviewWhereInput;
  revisionWhere: Prisma.RevisionNodeWhereInput;
  terminationReviewWhere: Prisma.TerminationReviewWhereInput;
  projectRequestWhere: Prisma.ProjectEstablishmentRequestWhereInput;
}) {
  const nextNodePosition = positions.TASK_NEXT_NODE;
  const milestoneReviewPosition = positions.MILESTONE_REVIEW;
  const revisionPosition = positions.REVISION_REVIEW;
  const projectPosition = positions.PROJECT_ESTABLISHMENT;
  const terminationReviewPosition = positions.TERMINATION_REVIEW;
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

  const [
    nextMilestones,
    nextTerminations,
    reviews,
    revisions,
    terminationReviews,
    projectRequests,
    counts,
    criticalCounts,
  ] = await Promise.all([
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

  return {
    nextMilestones,
    nextTerminations,
    reviews,
    revisions,
    terminationReviews,
    projectRequests,
    counts,
    criticalCounts,
  };
}

export type ActionInboxSources = Awaited<
  ReturnType<typeof loadActionInboxSources>
>;
