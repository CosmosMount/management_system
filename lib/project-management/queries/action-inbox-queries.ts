import type { Prisma } from "@prisma/client";
import {
  isSystemAdministrator,
  segmentReadableWhere,
  taskReadableWhere,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  decodeActionInboxCursor,
  encodeActionInboxCursor,
  type ActionInboxCursorPositions,
} from "@/lib/project-management/queries/action-inbox-cursor";
import {
  assertCursorAnchors,
  invalidCursorError,
} from "@/lib/project-management/queries/action-inbox-cursor-validation";
import {
  buildActionInboxCandidates,
  compareStreamItems,
  emptyActionInboxPage,
} from "@/lib/project-management/queries/action-inbox-item-builder";
import { loadActionInboxSources } from "@/lib/project-management/queries/action-inbox-query-loader";
import type { ActionInboxPage } from "@/lib/project-management/queries/action-inbox-types";
import { actionInboxPageInputSchema } from "@/lib/project-management/validations/action-inbox";

export type {
  ActionInboxItem,
  ActionInboxKind,
  ActionInboxPage,
  ActionInboxSeverity,
} from "@/lib/project-management/queries/action-inbox-types";

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

  const take = parsed.limit + 1;
  const sources = await loadActionInboxSources({
    positions,
    generatedAt,
    take,
    confirmationSegmentWhere,
    nextMilestoneWhere,
    nextTerminationWhere,
    milestoneReviewWhere,
    revisionWhere,
    terminationReviewWhere,
    projectRequestWhere,
  });
  const candidates = buildActionInboxCandidates({
    actor,
    generatedAt,
    take,
    sources,
  });
  const { counts, criticalCounts } = sources;

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
