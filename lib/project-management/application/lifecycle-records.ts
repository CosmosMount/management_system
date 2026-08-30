import type {
  Prisma,
  TaskMemberRole,
  TaskPriority,
  TaskStatus,
} from "@prisma/client";

export const lifecyclePlanNodeInclude = {
  node: {
    include: {
      milestone: true,
      revision: true,
      termination: true,
      planVersionEntries: {
        take: 2,
        select: { planVersionId: true },
      },
    },
  },
} satisfies Prisma.PlanVersionNodeInclude;

export type LifecyclePlanEntry = Prisma.PlanVersionNodeGetPayload<{
  include: typeof lifecyclePlanNodeInclude;
}>;

export type LifecycleTaskForAuthorization = {
  id: string;
  title: string;
  team: string;
  techGroup: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdByAccountId: string;
  currentPlanVersionId: string;
  activeMilestoneNodeId: string | null;
  lockVersion: number;
  updatedAt: Date;
  deletedAt: Date | null;
  members: Array<{
    personId: string;
    role: TaskMemberRole;
    removedAt: Date | null;
  }>;
};

export type LifecycleNotificationRecipient = {
  accountId: string;
  openId: string | null;
};
