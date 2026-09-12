import type { Prisma } from "@prisma/client";

export const canvasTaskAuthorizationSelect = {
  id: true,
  team: true,
  techGroup: true,
  status: true,
  priority: true,
  createdByAccountId: true,
  members: {
    where: { removedAt: null },
    select: { personId: true, role: true, removedAt: true },
  },
} satisfies Prisma.TaskSelect;

export const canvasRowTaskSelect = {
  ...canvasTaskAuthorizationSelect,
  project: { where: { deletedAt: null }, select: { id: true, name: true } },
  title: true,
  createdAt: true,
} satisfies Prisma.TaskSelect;

export const fullSegmentSelect = {
  id: true,
  personId: true,
  startAt: true,
  endAt: true,
  content: true,
  taskId: true,
  deletedAt: true,
  updatedAt: true,
  task: { select: { ...canvasTaskAuthorizationSelect, title: true } },
} satisfies Prisma.WorkSegmentSelect;

export const busyCandidateSelect = {
  personId: true,
  startAt: true,
  endAt: true,
} satisfies Prisma.WorkSegmentSelect;

export const anchorTaskSelect = {
  ...canvasRowTaskSelect,
  activeMilestoneNodeId: true,
  updatedAt: true,
  nodes: {
    where: {
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
    select: { id: true },
    take: 2,
  },
  currentPlanVersion: {
    select: {
      plannedStartAt: true,
      activatedAt: true,
      nodes: {
        where: { node: { deletedAt: null } },
        orderBy: { sequence: "asc" },
        select: {
          sequence: true,
          node: {
            select: {
              id: true,
              taskId: true,
              type: true,
              status: true,
              businessDescription: true,
              deletedAt: true,
              updatedAt: true,
              milestone: {
                select: {
                  goal: true,
                  expectedCompletedAt: true,
                },
              },
              revision: {
                select: {
                  reason: true,
                  revisionAt: true,
                },
              },
              termination: {
                select: {
                  name: true,
                  plannedOutcomeCriteria: true,
                  plannedAt: true,
                  reviews: {
                    where: { result: "PENDING" },
                    select: { id: true },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.TaskSelect;

export type CanvasTask = Prisma.TaskGetPayload<{
  select: typeof canvasRowTaskSelect;
}>;

export type FullSegment = Prisma.WorkSegmentGetPayload<{
  select: typeof fullSegmentSelect;
}>;

export type AnchorTask = Prisma.TaskGetPayload<{
  select: typeof anchorTaskSelect;
}>;
