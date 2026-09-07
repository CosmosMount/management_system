import {
  Prisma,
} from "@prisma/client";

export const segmentInclude = {
  person: {
    select: {
      id: true,
      displayName: true,
      status: true,
      accountId: true,
    },
  },
  task: {
    select: {
      id: true,
      title: true,
      team: true,
      techGroup: true,
      status: true,
      priority: true,
      currentPlanVersionId: true,
      deletedAt: true,
      members: {
        where: { removedAt: null },
        select: { personId: true, role: true, removedAt: true },
      },
    },
  },
} satisfies Prisma.WorkSegmentInclude;

export type SegmentForMutation = Prisma.WorkSegmentGetPayload<{
  include: typeof segmentInclude;
}>;

export type TaskForSegmentAuthorization = NonNullable<
  SegmentForMutation["task"]
>;

export type WorkSegmentDto = {
  id: string;
  personId: string;
  startAt: string;
  endAt: string;
  content: string;
  taskId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function snapshotSegment(
  segment: SegmentForMutation,
): Prisma.InputJsonObject {
  return {
    id: segment.id,
    personId: segment.personId,
    startAt: segment.startAt.toISOString(),
    endAt: segment.endAt.toISOString(),
    content: segment.content,
    taskId: segment.taskId,
    deletedAt: segment.deletedAt?.toISOString() ?? null,
    updatedAt: segment.updatedAt.toISOString(),
  };
}

export function toWorkSegmentDto(segment: SegmentForMutation): WorkSegmentDto {
  return {
    id: segment.id,
    personId: segment.personId,
    startAt: segment.startAt.toISOString(),
    endAt: segment.endAt.toISOString(),
    content: segment.content,
    taskId: segment.taskId,
    deletedAt: segment.deletedAt?.toISOString() ?? null,
    createdAt: segment.createdAt.toISOString(),
    updatedAt: segment.updatedAt.toISOString(),
  };
}
