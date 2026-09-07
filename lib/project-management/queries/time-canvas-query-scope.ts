import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  segmentReadableWhere,
  taskReadableWhere,
} from "@/lib/project-management/authorization";
import { notFoundError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  canvasRowTaskSelect,
  type CanvasTask,
} from "@/lib/project-management/queries/time-canvas-records";
import type { GetTimeCanvasDataInput } from "@/lib/project-management/validations/time-canvas";

export async function authorizeScopeAndExplicitFilters(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  authorizedSegmentFilter: Prisma.WorkSegmentWhereInput,
): Promise<CanvasTask | null> {
  let scopeTask: CanvasTask | null = null;
  if (input.scope.kind === "TASK_SCOPED") {
    scopeTask = await prisma.task.findFirst({
      where: {
        AND: [{ id: input.scope.taskId }, taskReadableWhere(actor)],
      },
      select: canvasRowTaskSelect,
    });
    if (!scopeTask) throw notFoundError();
    if (
      input.taskIds.length > 0 &&
      input.taskIds.some((taskId) => taskId !== scopeTask?.id)
    ) {
      throw notFoundError();
    }
  }
  if (
    (input.scope.kind === "PERSONAL" || input.scope.kind === "DASHBOARD") &&
    input.personIds.some((personId) => personId !== actor.personId)
  ) {
    throw notFoundError();
  }

  if (input.personIds.length > 0) {
    const personWhere = personUniverseWhere(actor, input, scopeTask);
    const count = await prisma.person.count({
      where: {
        AND: [
          { id: { in: input.personIds } },
          personWhere,
          personAvailableInRangeWhere(authorizedSegmentFilter),
        ],
      },
    });
    if (count !== input.personIds.length) throw notFoundError();
  }
  if (input.taskIds.length > 0) {
    const count = await prisma.task.count({
      where: {
        AND: [
          { id: { in: input.taskIds } },
          taskReadableWhere(actor),
        ],
      },
    });
    if (count !== input.taskIds.length) throw notFoundError();
  }
  return scopeTask;
}

export function personAvailableInRangeWhere(
  authorizedSegmentFilter: Prisma.WorkSegmentWhereInput,
): Prisma.PersonWhereInput {
  return {
    OR: [
      { status: "ACTIVE" },
      { workSegments: { some: authorizedSegmentFilter } },
    ],
  };
}

export function personUniverseWhere(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
): Prisma.PersonWhereInput {
  if (input.scope.kind === "PERSONAL" || input.scope.kind === "DASHBOARD") {
    return { id: actor.personId };
  }
  if (input.scope.kind === "TASK_SCOPED") {
    return {
      taskMembers: {
        some: { taskId: scopeTask?.id ?? input.scope.taskId, removedAt: null },
      },
    };
  }
  return {
    OR: [
      { status: "ACTIVE" },
      {
        workSegments: {
          some: segmentReadableWhere(actor),
        },
      },
    ],
  };
}

export function taskUniverseWhere(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
): Prisma.TaskWhereInput {
  if (input.scope.kind === "TASK_SCOPED") {
    return {
      AND: [taskReadableWhere(actor), { id: scopeTask?.id ?? input.scope.taskId }],
    };
  }
  if (input.scope.kind === "PERSONAL" || input.scope.kind === "DASHBOARD") {
    return {
      AND: [
        taskReadableWhere(actor),
        {
          members: {
            some: { personId: actor.personId, removedAt: null },
          },
        },
      ],
    };
  }
  return taskReadableWhere(actor);
}

export function fullSegmentUniverseWhere(
  input: GetTimeCanvasDataInput,
  rowUniverseWhere: Prisma.PersonWhereInput | Prisma.TaskWhereInput,
  authorizedSegmentFilter: Prisma.WorkSegmentWhereInput,
): Prisma.WorkSegmentWhereInput {
  return {
    AND: [
      authorizedSegmentFilter,
      input.groupBy === "PERSON"
        ? { person: rowUniverseWhere as Prisma.PersonWhereInput }
        : {
            task: {
              is: rowUniverseWhere as Prisma.TaskWhereInput,
            },
          },
    ],
  };
}

export function authorizedSegmentFilterWhere(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  includeRange = true,
): Prisma.WorkSegmentWhereInput {
  return {
    AND: [
      segmentReadableWhere(actor),
      segmentFilterWhere(input, actor.personId, includeRange),
    ],
  };
}

function segmentFilterWhere(
  input: GetTimeCanvasDataInput,
  actorPersonId: string,
  includeRange = true,
): Prisma.WorkSegmentWhereInput {
  return {
    AND: [
      {
        deletedAt: null,
        ...(includeRange
          ? {
              startAt: { lt: input.rangeEnd },
              endAt: { gt: input.rangeStart },
            }
          : {}),
      },
      input.scope.kind === "PERSONAL" || input.scope.kind === "DASHBOARD"
        ? { personId: actorPersonId }
        : {},
      input.personIds.length > 0
        ? { personId: { in: input.personIds } }
        : input.emptyPersonIdsMeansNone
          ? { personId: { in: [] } }
          : {},
      input.taskIds.length > 0 ? { taskId: { in: input.taskIds } } : {},
    ],
  };
}
