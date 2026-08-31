import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validationError } from "@/lib/project-management/application/errors";
import type {
  ActionInboxCursorPosition,
  ActionInboxCursorPositions,
} from "@/lib/project-management/queries/action-inbox-cursor";

export function invalidCursorError() {
  return validationError("分页游标无效或已不再匹配当前待办队列", {
    cursor: ["分页游标无效或已不再匹配当前待办队列"],
  });
}

export function positionDate(position: ActionInboxCursorPosition) {
  const date = new Date(position.relevantAt);
  if (Number.isNaN(date.getTime())) throw invalidCursorError();
  return date;
}

export async function assertCursorAnchors({
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
