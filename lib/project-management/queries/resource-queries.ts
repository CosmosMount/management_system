import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authorize,
  segmentReadableWhere,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { notFoundError } from "@/lib/project-management/application/errors";
import { toWorkSegmentDto } from "@/lib/project-management/application/segment-service";
import {
  canFullyHandleConflict,
  resourceConflictCapabilities,
} from "@/lib/project-management/application/conflict-permissions";
import {
  getResourceConflictInputSchema,
  getWorkSegmentInputSchema,
  listResourceConflictsInputSchema,
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
  allowSelfReview: true,
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

export async function listResourceConflicts({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const parsed = listResourceConflictsInputSchema.parse(input);
  const where: Prisma.ResourceConflictWhereInput = {
    AND: [
      conflictReadableWhere(actor),
      parsed.personId ? { personId: parsed.personId } : {},
      parsed.status ? { status: parsed.status } : {},
      parsed.kind ? { kind: parsed.kind } : {},
      parsed.severity ? { severity: parsed.severity } : {},
      timeOverlapWhere(parsed.startAt, parsed.endAt),
    ],
  };
  const rows = await prisma.resourceConflict.findMany({
    where,
    include: conflictInclude,
    orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
    take: parsed.limit + 1,
    ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}),
  });
  return {
    items: rows.slice(0, parsed.limit).map((row) => toResourceConflictDto(row, actor)),
    nextCursor: rows.length > parsed.limit ? rows[parsed.limit]?.id ?? null : null,
  };
}

export async function getResourceConflict({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const parsed = getResourceConflictInputSchema.parse(input);
  const row = await prisma.resourceConflict.findFirst({
    where: { AND: [{ id: parsed.conflictId }, conflictReadableWhere(actor)] },
    include: conflictInclude,
  });
  if (!row) throw notFoundError();
  return toResourceConflictDto(row, actor);
}

export async function listTimelinePeople({
  actor,
}: {
  actor: ProjectManagementActor;
}): Promise<Array<{ id: string; displayName: string }>> {
  const [actorPerson, segmentPeople] = await Promise.all([
    prisma.person.findUnique({
      where: { id: actor.personId },
      select: { id: true, displayName: true },
    }),
    prisma.workSegment.findMany({
      where: segmentReadableWhere(actor),
      distinct: ["personId"],
      select: {
        person: { select: { id: true, displayName: true } },
      },
      orderBy: { personId: "asc" },
      take: 200,
    }),
  ]);
  const byId = new Map<string, { id: string; displayName: string }>();
  if (actorPerson) byId.set(actorPerson.id, actorPerson);
  for (const row of segmentPeople) {
    byId.set(row.person.id, row.person);
  }
  return [...byId.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName, "zh-CN"),
  );
}

export type WorkSegmentListResult = Awaited<ReturnType<typeof listWorkSegments>>;
export type WorkSegmentDetail = WorkSegmentListResult["items"][number];
export type ResourceConflictListResult = Awaited<
  ReturnType<typeof listResourceConflicts>
>;
export type ResourceConflictDetail = ResourceConflictListResult["items"][number];

const conflictInclude = {
  person: { select: { displayName: true } },
  segments: {
    include: {
      segment: {
        include: segmentQueryInclude,
      },
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.ResourceConflictInclude;

function conflictReadableWhere(
  actor: ProjectManagementActor,
): Prisma.ResourceConflictWhereInput {
  return {
    OR: [
      { personId: actor.personId },
      { segments: { some: { segment: segmentReadableWhere(actor) } } },
      { segments: { some: { segment: { task: taskReadableWhere(actor) } } } },
    ],
  };
}

function timeOverlapWhere(
  startAt?: Date,
  endAt?: Date,
): Prisma.WorkSegmentWhereInput & Prisma.ResourceConflictWhereInput {
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

function toResourceConflictDto(
  conflict: Prisma.ResourceConflictGetPayload<{ include: typeof conflictInclude }>,
  actor: ProjectManagementActor,
) {
  const visibleSegmentEntries = conflict.segments.filter((entry) =>
    segmentVisible(actor, entry.segment),
  );
  const hiddenSegmentCount = conflict.segments.length - visibleSegmentEntries.length;
  const visibleSegmentIds = new Set(
    visibleSegmentEntries.map((entry) => entry.segmentId),
  );
  const redactHandlingText =
    hiddenSegmentCount > 0 && !canFullyHandleConflict(actor, conflict);
  return {
    id: conflict.id,
    personId: conflict.personId,
    personName: conflict.person.displayName,
    kind: conflict.kind,
    startAt: conflict.startAt.toISOString(),
    endAt: conflict.endAt.toISOString(),
    severity: conflict.severity,
    status: conflict.status,
    fingerprint: conflict.fingerprint,
    explanation: sanitizeConflictExplanation(
      conflict.explanation,
      visibleSegmentIds,
      hiddenSegmentCount,
      redactHandlingText,
    ),
    detectedAt: conflict.detectedAt.toISOString(),
    acknowledgedAt: conflict.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: conflict.resolvedAt?.toISOString() ?? null,
    ignoredUntil: conflict.ignoredUntil?.toISOString() ?? null,
    resolvedByAccountId: conflict.resolvedByAccountId,
    resolutionNote: sanitizeHandlingText(
      conflict.resolutionNote,
      redactHandlingText,
    ),
    hiddenSegmentCount,
    capabilities: resourceConflictCapabilities(actor, conflict),
    segments: visibleSegmentEntries.map((entry) =>
      toWorkSegmentDetailDto(entry.segment, actor),
    ),
    createdAt: conflict.createdAt.toISOString(),
    updatedAt: conflict.updatedAt.toISOString(),
  };
}

type SegmentQueryPayload = Prisma.WorkSegmentGetPayload<{
  include: typeof segmentQueryInclude;
}>;

function segmentVisible(actor: ProjectManagementActor, segment: SegmentQueryPayload) {
  return sourceSegmentVisible(actor, segment);
}

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
    allowSelfReview: task.allowSelfReview,
    members: task.members,
  };
}

function sanitizeConflictExplanation(
  explanation: Prisma.JsonValue,
  visibleSegmentIds: Set<string>,
  hiddenSegmentCount: number,
  redactHandlingText: boolean,
): Prisma.JsonValue {
  if (!explanation || typeof explanation !== "object" || Array.isArray(explanation)) {
    return explanation;
  }
  const record = explanation as Record<string, unknown>;
  const sanitized: Record<string, unknown> =
    hiddenSegmentCount > 0 ? { ...record, hiddenSegmentCount } : { ...record };
  for (const key of CONFLICT_EXPLANATION_SEGMENT_ID_ARRAY_KEYS) {
    const segmentIds = record[key];
    if (Array.isArray(segmentIds)) {
      sanitized[key] = segmentIds.filter(
        (segmentId): segmentId is string =>
          typeof segmentId === "string" && visibleSegmentIds.has(segmentId),
      );
    }
  }
  if (Array.isArray(record.segments)) {
    sanitized.segments = record.segments.filter(
      (segment) =>
        segment &&
        typeof segment === "object" &&
        !Array.isArray(segment) &&
        typeof (segment as { id?: unknown }).id === "string" &&
        visibleSegmentIds.has((segment as { id: string }).id),
    );
  }
  if (redactHandlingText) {
    if (typeof record.resolutionNote === "string") {
      sanitized.resolutionNote = REDACTED_CONFLICT_HANDLING_TEXT;
    }
    if (typeof record.ignoredReason === "string") {
      sanitized.ignoredReason = REDACTED_CONFLICT_HANDLING_TEXT;
    }
  }
  return sanitized as Prisma.JsonObject;
}

const CONFLICT_EXPLANATION_SEGMENT_ID_ARRAY_KEYS = [
  "segmentIds",
  "changedSegmentIds",
  "missingAllocationSegmentIds",
] as const;

const REDACTED_CONFLICT_HANDLING_TEXT = "处理说明涉及不可见记录，已隐藏";

function sanitizeHandlingText(value: string | null, redact: boolean) {
  if (!value || !redact) return value;
  return REDACTED_CONFLICT_HANDLING_TEXT;
}
