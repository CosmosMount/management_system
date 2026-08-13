import type { Prisma } from "@prisma/client";

export const taskMutationInclude = {
  members: {
    where: { removedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.TaskInclude;

export type TaskForMutation = Prisma.TaskGetPayload<{
  include: typeof taskMutationInclude;
}>;

export const taskMutationPlanNodeInclude = {
  node: {
    include: {
      milestone: true,
      revision: true,
      termination: true,
    },
  },
} satisfies Prisma.PlanVersionNodeInclude;

export type TaskMutationPlanEntry = Prisma.PlanVersionNodeGetPayload<{
  include: typeof taskMutationPlanNodeInclude;
}>;

export type PlanForMutation = Prisma.TaskPlanVersionGetPayload<{
  include: {
    nodes: {
      include: typeof taskMutationPlanNodeInclude;
      orderBy: { sequence: "asc" };
    };
  };
}>;
