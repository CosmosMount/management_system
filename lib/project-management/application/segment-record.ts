import {
  Prisma,
  type TaskPriority,
  type WorkSegment,
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
  type: WorkSegment["type"];
  status: WorkSegment["status"];
  startAt: string;
  endAt: string;
  content: string;
  priority: TaskPriority;
  expectedOutput: string;
  actualOutput: string;
  taskId: string | null;
  sourceSplitFromId: string | null;
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
    type: segment.type,
    status: segment.status,
    startAt: segment.startAt.toISOString(),
    endAt: segment.endAt.toISOString(),
    content: segment.content,
    priority: segment.priority,
    expectedOutput: segment.expectedOutput,
    actualOutput: segment.actualOutput,
    taskId: segment.taskId,
    sourceSplitFromId: segment.sourceSplitFromId,
    deletedAt: segment.deletedAt?.toISOString() ?? null,
    updatedAt: segment.updatedAt.toISOString(),
  };
}

export function toWorkSegmentDto(segment: SegmentForMutation): WorkSegmentDto {
  return {
    id: segment.id,
    personId: segment.personId,
    type: segment.type,
    status: segment.status,
    startAt: segment.startAt.toISOString(),
    endAt: segment.endAt.toISOString(),
    content: segment.content,
    priority: segment.priority,
    expectedOutput: segment.expectedOutput,
    actualOutput: segment.actualOutput,
    taskId: segment.taskId,
    sourceSplitFromId: segment.sourceSplitFromId,
    deletedAt: segment.deletedAt?.toISOString() ?? null,
    createdAt: segment.createdAt.toISOString(),
    updatedAt: segment.updatedAt.toISOString(),
  };
}
