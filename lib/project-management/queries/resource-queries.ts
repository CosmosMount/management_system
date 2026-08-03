import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authorize,
  segmentReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { notFoundError } from "@/lib/project-management/application/errors";
import { toWorkSegmentDto } from "@/lib/project-management/application/segment-service";
import {
  getWorkSegmentInputSchema,
  listWorkSegmentChangesInputSchema,
  listWorkSegmentsInputSchema,
} from "@/lib/project-management/validations/segments";

const segmentTaskSelect = {
  id: true,
  title: true,
  team: true,
  techGroup: true,
  status: true,
  priority: true,
  members: {
    where: { removedAt: null },
    select: { personId: true, role: true, removedAt: true },
  },
} satisfies Prisma.TaskSelect;

const segmentQueryInclude = {
  person: { select: { displayName: true } },
  task: { select: segmentTaskSelect },
  node: { select: { id: true, type: true, status: true } },
  tags: {
    select: {
      tag: { select: { id: true, name: true, color: true } },
    },
  },
  plannedSources: {
    select: {
      id: true,
      actualSegmentId: true,
      coveredStartAt: true,
      coveredEndAt: true,
      actualSegment: {
        select: {
          id: true,
          personId: true,
          startAt: true,
          endAt: true,
          deletedAt: true,
          task: { select: segmentTaskSelect },
        },
      },
    },
  },
  actualSources: {
    select: {
      id: true,
      plannedSegmentId: true,
      coveredStartAt: true,
      coveredEndAt: true,
      plannedSegment: {
        select: {
          id: true,
          personId: true,
          startAt: true,
          endAt: true,
          status: true,
          deletedAt: true,
          task: { select: segmentTaskSelect },
        },
      },
    },
  },
} satisfies Prisma.WorkSegmentInclude;

export async function listWorkSegments({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const parsed = listWorkSegmentsInputSchema.parse(input);
  const where: Prisma.WorkSegmentWhereInput = {
    AND: [
      segmentReadableWhere(actor),
      parsed.personId ? { personId: parsed.personId } : {},
      parsed.taskId ? { taskId: parsed.taskId } : {},
      parsed.nodeId ? { nodeId: parsed.nodeId } : {},
      parsed.type ? { type: parsed.type } : {},
      parsed.status ? { status: parsed.status } : {},
      parsed.associationNeedsReview === undefined
        ? {}
        : { associationNeedsReview: parsed.associationNeedsReview },
      timeOverlapWhere(parsed.startAt, parsed.endAt),
    ],
  };
  const rows = await prisma.workSegment.findMany({
    where,
    include: segmentQueryInclude,
    orderBy: [{ startAt: "asc" }, { id: "asc" }],
    take: parsed.limit + 1,
    ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}),
  });
  return {
    items: rows.slice(0, parsed.limit).map((row) =>
      toWorkSegmentDetailDto(row, actor),
    ),
    nextCursor: rows.length > parsed.limit ? rows[parsed.limit]?.id ?? null : null,
  };
}

export async function getWorkSegment({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const parsed = getWorkSegmentInputSchema.parse(input);
  const row = await prisma.workSegment.findFirst({
    where: {
      AND: [{ id: parsed.segmentId }, segmentReadableWhere(actor)],
    },
    include: segmentQueryInclude,
  });
  if (!row) throw notFoundError();
  return toWorkSegmentDetailDto(row, actor);
}

export async function listWorkSegmentChanges({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const parsed = listWorkSegmentChangesInputSchema.parse(input);
  const segment = await prisma.workSegment.findFirst({
    where: {
      AND: [{ id: parsed.segmentId }, segmentReadableWhere(actor)],
    },
    select: { id: true },
  });
  if (!segment) throw notFoundError();
  const rows = await prisma.workSegmentChange.findMany({
    where: { segmentId: parsed.segmentId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: parsed.limit + 1,
    ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}),
  });
  return {
    items: rows.slice(0, parsed.limit).map((row) => ({
      id: row.id,
      segmentId: row.segmentId,
      action: row.action,
      before: row.before,
      after: row.after,
      reason: row.reason,
      actorAccountId: row.actorAccountId,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: rows.length > parsed.limit ? rows[parsed.limit]?.id ?? null : null,
  };
}

export async function listTimelinePeople({
  actor,
}: {
  actor: ProjectManagementActor;
}): Promise<Array<{ id: string; displayName: string }>> {
  const people = await prisma.person.findMany({
    where: {
      OR: [
        { status: "ACTIVE" },
        { workSegments: { some: segmentReadableWhere(actor) } },
      ],
    },
    select: { id: true, displayName: true, status: true },
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
    take: 5_000,
  });
  return people.map((person) => ({
    id: person.id,
    displayName:
      person.status === "INACTIVE"
        ? `${person.displayName}（已停用）`
        : person.displayName,
  })).sort((left, right) =>
    left.displayName.localeCompare(right.displayName, "zh-CN"),
  );
}

export type WorkSegmentListResult = Awaited<ReturnType<typeof listWorkSegments>>;
export type WorkSegmentDetail = WorkSegmentListResult["items"][number];
function timeOverlapWhere(
  startAt?: Date,
  endAt?: Date,
): Prisma.WorkSegmentWhereInput {
  if (!startAt && !endAt) return {};
  return {
    ...(endAt ? { startAt: { lt: endAt } } : {}),
    ...(startAt ? { endAt: { gt: startAt } } : {}),
  };
}

function toWorkSegmentDetailDto(
  segment: Prisma.WorkSegmentGetPayload<{ include: typeof segmentQueryInclude }>,
  actor: ProjectManagementActor,
) {
  const task = segment.task
    ? {
        id: segment.task.id,
        title: segment.task.title,
        team: segment.task.team,
        techGroup: segment.task.techGroup,
      }
    : null;
  return {
    ...toWorkSegmentDto({
      ...segment,
      task: null,
      person: {
        id: segment.personId,
        displayName: segment.person.displayName,
        status: "ACTIVE",
        accountId: null,
      },
      node: null,
      tags: segment.tags.map((entry) => ({ tagId: entry.tag.id })),
    }),
    personName: segment.person.displayName,
    task,
    node: segment.node,
    tags: segment.tags.map((entry) => entry.tag),
    plannedSources: segment.plannedSources
      .filter((source) => sourceSegmentVisible(actor, source.actualSegment))
      .map((source) => ({
        id: source.id,
        actualSegmentId: source.actualSegmentId,
        coveredStartAt: source.coveredStartAt.toISOString(),
        coveredEndAt: source.coveredEndAt.toISOString(),
        actualSegment: {
          id: source.actualSegment.id,
          startAt: source.actualSegment.startAt.toISOString(),
          endAt: source.actualSegment.endAt.toISOString(),
          deletedAt: source.actualSegment.deletedAt?.toISOString() ?? null,
        },
      })),
    actualSources: segment.actualSources
      .filter((source) => sourceSegmentVisible(actor, source.plannedSegment))
      .map((source) => ({
        id: source.id,
        plannedSegmentId: source.plannedSegmentId,
        coveredStartAt: source.coveredStartAt.toISOString(),
        coveredEndAt: source.coveredEndAt.toISOString(),
        plannedSegment: {
          id: source.plannedSegment.id,
          startAt: source.plannedSegment.startAt.toISOString(),
          endAt: source.plannedSegment.endAt.toISOString(),
          status: source.plannedSegment.status,
        },
      })),
  };
}

type SegmentQueryPayload = Prisma.WorkSegmentGetPayload<{
  include: typeof segmentQueryInclude;
}>;

function sourceSegmentVisible(
  actor: ProjectManagementActor,
  segment: {
    personId: string;
    deletedAt?: Date | null;
    task: NonNullable<SegmentQueryPayload["task"]> | null;
  },
) {
  if (segment.deletedAt) return false;
  return authorize({
    actor,
    action: "segment.view",
    resource: {
      type: "segment",
      personId: segment.personId,
      task: segment.task ? taskResource(segment.task) : null,
    },
  }).allowed;
}

function taskResource(
  task: NonNullable<SegmentQueryPayload["task"]>,
): AuthorizationTaskResource {
  return {
    type: "task",
    id: task.id,
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    priority: task.priority,
    members: task.members,
  };
}
