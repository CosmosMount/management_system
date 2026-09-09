import type { Prisma } from "@prisma/client";

export const currentDeadlinePlanNodesSelect = {
  where: {
    node: { type: { in: ["MILESTONE", "TERMINATION"] }, status: "ACTIVE", deletedAt: null },
  },
  select: {
    node: {
      select: {
        id: true,
        type: true,
        status: true,
        milestone: { select: { expectedCompletedAt: true } },
        termination: { select: { name: true, plannedAt: true } },
      },
    },
  },
} satisfies Prisma.TaskPlanVersion$nodesArgs;
