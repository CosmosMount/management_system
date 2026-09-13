import type { Prisma, Task } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authorize,
  isSystemAdministrator,
  taskReadableWhere,
} from "@/lib/project-management/authorization";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import {
  isTaskCreatableForSegment,
  TASK_SEGMENT_CREATABLE_STATUSES,
} from "@/lib/project-management/domain/task-segment-policy";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { canCreateForPerson } from "@/lib/project-management/queries/time-canvas-dto";
import {
  personAvailableInRangeWhere,
  personUniverseWhere,
  taskUniverseWhere,
} from "@/lib/project-management/queries/time-canvas-query-scope";
import {
  canvasRowTaskSelect,
  type CanvasTask,
} from "@/lib/project-management/queries/time-canvas-records";
import type { TimeCanvasRowDto } from "@/lib/project-management/types/time-canvas";
import type { GetTimeCanvasDataInput } from "@/lib/project-management/validations/time-canvas";

type RowPage = {
  rows: TimeCanvasRowDto[];
  rowIds: string[];
  rowUniverseWhere: Prisma.PersonWhereInput | Prisma.TaskWhereInput;
};

export async function loadPersonRows(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
  authorizedSegmentFilter: Prisma.WorkSegmentWhereInput,
): Promise<RowPage> {
  const universe = personUniverseWhere(actor, input, scopeTask);
  const where: Prisma.PersonWhereInput = {
    AND: [
      universe,
      personAvailableInRangeWhere(authorizedSegmentFilter),
      input.personIds.length > 0 ? { id: { in: input.personIds } } : {},
    ],
  };
  const people = await prisma.person.findMany({
    where,
    select: {
      id: true,
      displayName: true,
      status: true,
      taskMembers:
        input.scope.kind === "TASK_SCOPED"
          ? {
              where: { taskId: input.scope.taskId, removedAt: null },
              select: { role: true },
              orderBy: { role: "asc" as const },
            }
          : false,
    },
    orderBy: [{ displayName: "asc" }, { id: "asc" }],
  });
  const canCreateByPersonId = await loadPersonCreateCapabilities(
    actor,
    input,
    scopeTask,
    people.map((person) => person.id),
  );
  const rows = people.map((person) => {
    const taskMembers = "taskMembers" in person ? person.taskMembers : [];
    return {
      kind: "PERSON" as const,
      id: person.id,
      label:
        person.status === "INACTIVE"
          ? `${person.displayName}（已停用）`
          : person.displayName,
      sublabel:
        taskMembers.length > 0
          ? taskMembers.map((member) => member.role).join(" / ")
          : null,
      capabilities: {
        canCreateSegment:
          person.status === "ACTIVE" &&
          (canCreateByPersonId.get(person.id) ?? false),
      },
    };
  });
  return {
    rows,
    rowIds: rows.map((row) => row.id),
    rowUniverseWhere: where,
  };
}

export async function loadTaskRows(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
): Promise<RowPage> {
  const actorCanCreateSegments = Boolean(
    await prisma.person.findFirst({
      where: {
        id: actor.personId,
        accountId: actor.accountId,
        status: "ACTIVE",
      },
      select: { id: true },
    }),
  );
  const universe = taskUniverseWhere(actor, input, scopeTask);
  const where: Prisma.TaskWhereInput = {
    AND: [
      universe,
      input.taskIds.length > 0 ? { id: { in: input.taskIds } } : {},
    ],
  };
  const tasks = await prisma.task.findMany({
    where,
    select: canvasRowTaskSelect,
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });
  const rows = tasks.map((task) => ({
    kind: "TASK" as const,
    id: task.id,
    label: task.title,
    project: task.project,
    sublabel: `${task.status} / ${task.priority}`,
    capabilities: {
      canCreateSegment:
        actorCanCreateSegments &&
        isTaskCreatableForSegment(task.status) &&
        authorize({
          actor,
          action: "segment.manage_self",
          resource: {
            type: "segment",
            personId: actor.personId,
            task: taskAuthorizationResource(task),
          },
        }).allowed,
    },
  }));
  return {
    rows,
    rowIds: rows.map((row) => row.id),
    rowUniverseWhere: where,
  };
}

async function loadPersonCreateCapabilities(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  scopeTask: CanvasTask | null,
  personIds: string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (personIds.length === 0) return result;

  const singleTaskId =
    scopeTask?.id ?? (input.taskIds.length === 1 ? input.taskIds[0] : undefined);
  if (singleTaskId) {
    const task =
      scopeTask ??
      (await prisma.task.findFirst({
        where: {
          AND: [{ id: singleTaskId }, taskReadableWhere(actor)],
        },
        select: canvasRowTaskSelect,
      }));
    for (const personId of personIds) {
      result.set(
        personId,
        Boolean(
          task &&
            isEligibleSegmentTask(task.status) &&
            hasActiveTaskMember(task, personId) &&
            canCreateForPerson(actor, personId, task),
        ),
      );
    }
    return result;
  }

  const hasOtherPeople = personIds.some(
    (personId) => personId !== actor.personId,
  );
  const selfRequiresTask = input.taskIds.length > 0;
  const otherPersonIds = personIds.filter(
    (personId) => personId !== actor.personId,
  );
  const [hasSelfEligibleTask, manageablePersonIds] = await Promise.all([
    selfRequiresTask && personIds.includes(actor.personId)
      ? eligibleTaskExists(input, {
          AND: [
            taskReadableWhere(actor),
            {
              members: {
                some: {
                  personId: actor.personId,
                  role: { in: ["OWNER", "PARTICIPANT"] },
                  removedAt: null,
                },
              },
            },
          ],
        })
      : Promise.resolve(false),
    hasOtherPeople
      ? manageableEligibleTaskPersonIds(actor, input, otherPersonIds)
      : Promise.resolve(new Set<string>()),
  ]);
  for (const personId of personIds) {
    result.set(
      personId,
      personId === actor.personId
        ? selfRequiresTask
          ? hasSelfEligibleTask
          : canCreateForPerson(actor, personId, null)
        : manageablePersonIds.has(personId),
    );
  }
  return result;
}

async function manageableEligibleTaskPersonIds(
  actor: ProjectManagementActor,
  input: GetTimeCanvasDataInput,
  personIds: string[],
): Promise<Set<string>> {
  const memberships = await prisma.taskMember.findMany({
    where: {
      personId: { in: personIds },
      role: { in: ["OWNER", "PARTICIPANT"] },
      removedAt: null,
      task: {
        AND: [
          manageableTaskWhere(actor),
          {
            status: { in: [...TASK_SEGMENT_CREATABLE_STATUSES] },
          },
          input.taskIds.length > 0 ? { id: { in: input.taskIds } } : {},
        ],
      },
    },
    select: { personId: true },
    distinct: ["personId"],
  });
  return new Set(memberships.map((membership) => membership.personId));
}

async function eligibleTaskExists(
  input: GetTimeCanvasDataInput,
  authorizationWhere: Prisma.TaskWhereInput,
): Promise<boolean> {
  const task = await prisma.task.findFirst({
    where: {
      AND: [
        authorizationWhere,
        {
          deletedAt: null,
          status: { in: [...TASK_SEGMENT_CREATABLE_STATUSES] },
        },
        input.taskIds.length > 0 ? { id: { in: input.taskIds } } : {},
      ],
    },
    select: { id: true },
  });
  return task !== null;
}

function manageableTaskWhere(
  actor: ProjectManagementActor,
): Prisma.TaskWhereInput {
  if (isSystemAdministrator(actor)) return { deletedAt: null };
  return {
    deletedAt: null,
    members: {
      some: {
        personId: actor.personId,
        role: "OWNER",
        removedAt: null,
      },
    },
  };
}

function isEligibleSegmentTask(status: Task["status"]): boolean {
  return isTaskCreatableForSegment(status);
}

function hasActiveTaskMember(task: CanvasTask, personId: string): boolean {
  return task.members.some(
    (member) =>
      member.personId === personId &&
      member.removedAt === null &&
      (member.role === "OWNER" || member.role === "PARTICIPANT"),
  );
}
