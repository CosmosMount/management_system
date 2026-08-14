import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  projectReadableWhere,
  segmentReadableWhere,
  taskReadableWhere,
} from "@/lib/project-management/authorization";
import { notFoundError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { DEFAULT_RESOURCE_PLAN_TASK_STATUSES } from "@/lib/project-management/resource-plan-url";
import { taskStatusValues } from "@/lib/project-management/types/contract-values";

const idList = z.array(z.string().uuid()).default([]).transform((ids) =>
  [...new Set(ids)].sort(),
);
const pinnedIdList = z.array(z.string().uuid()).max(1).default([]).transform((ids) =>
  [...new Set(ids)],
);
const taskStatusList = z
  .array(z.enum(taskStatusValues))
  .max(taskStatusValues.length)
  .default([...DEFAULT_RESOURCE_PLAN_TASK_STATUSES])
  .transform((statuses) => {
    const selected = new Set(statuses);
    return taskStatusValues.filter((status) => selected.has(status));
  });

const resourcePlanExplicitIdsSchema = z.object({
  projectIds: idList,
  taskIds: idList,
  personIds: idList,
}).strict();

const resourcePlanSelectionSchema = resourcePlanExplicitIdsSchema.extend({
  all: z.boolean().default(true),
  taskStatuses: taskStatusList,
  pinnedTaskIds: pinnedIdList,
  pinnedPersonIds: pinnedIdList,
}).strict();

type Selection = z.infer<typeof resourcePlanSelectionSchema>;

export async function getResourcePlanSelection({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const selection = resourcePlanSelectionSchema.parse(input);
  const { taskSelection, personSelection } = await assertSelectionExists(actor, selection);
  const explicitEmpty = !selection.all &&
    selection.projectIds.length === 0 &&
    selection.taskIds.length === 0 &&
    selection.personIds.length === 0 &&
    selection.pinnedTaskIds.length === 0 &&
    selection.pinnedPersonIds.length === 0;
  if (explicitEmpty) {
    return {
      taskIds: [],
      personIds: [],
      taskStatuses: selection.taskStatuses,
    };
  }

  const [tasks, people] = await Promise.all([
    prisma.task.findMany({
      where: taskSelection,
      select: { id: true },
      orderBy: [{ title: "asc" }, { id: "asc" }],
    }),
    prisma.person.findMany({
      where: personSelection,
      select: { id: true },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    }),
  ]);
  return {
    taskIds: pinFirst(tasks.map((task) => task.id), selection.pinnedTaskIds),
    personIds: pinFirst(people.map((person) => person.id), selection.pinnedPersonIds),
    taskStatuses: selection.taskStatuses,
  };
}

function pinFirst(ids: string[], pinnedIds: string[]) {
  if (pinnedIds.length === 0) return ids;
  const pinned = new Set(pinnedIds);
  return [...ids.filter((id) => pinned.has(id)), ...ids.filter((id) => !pinned.has(id))];
}

export async function resolveResourcePlanExplicitIds({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const selection = resourcePlanExplicitIdsSchema.parse(input);
  const [projects, tasks, people] = await Promise.all([
    prisma.project.findMany({
      where: {
        AND: [
          projectReadableWhere(actor),
          { id: { in: selection.projectIds } },
        ],
      },
      select: { id: true },
    }),
    prisma.task.findMany({
      where: {
        AND: [taskReadableWhere(actor), { id: { in: selection.taskIds } }],
      },
      select: { id: true },
    }),
    prisma.person.findMany({
      where: {
        id: { in: selection.personIds },
        OR: [
          { status: "ACTIVE" },
          { workSegments: { some: segmentReadableWhere(actor) } },
        ],
      },
      select: { id: true },
    }),
  ]);
  const projectIds = new Set(projects.map((project) => project.id));
  const taskIds = new Set(tasks.map((task) => task.id));
  const personIds = new Set(people.map((person) => person.id));
  return {
    projectIds: selection.projectIds.filter((id) => projectIds.has(id)),
    taskIds: selection.taskIds.filter((id) => taskIds.has(id)),
    personIds: selection.personIds.filter((id) => personIds.has(id)),
  };
}

function taskSelectionWhere(
  actor: ProjectManagementActor,
  selection: Selection,
): Prisma.TaskWhereInput {
  return {
    AND: [
      taskReadableWhere(actor),
      {
        AND: [
          { status: { in: selection.taskStatuses } },
          selection.all
            ? {}
            : {
                OR: [
                  selection.taskIds.length > 0
                    ? { id: { in: selection.taskIds } }
                    : { id: { in: [] } },
                  selection.projectIds.length > 0
                    ? { projectId: { in: selection.projectIds } }
                    : { id: { in: [] } },
                  selection.pinnedTaskIds.length > 0
                    ? { id: { in: selection.pinnedTaskIds } }
                    : { id: { in: [] } },
                ],
              },
        ],
      },
    ],
  };
}

function personSelectionWhere(
  actor: ProjectManagementActor,
  selection: Selection,
  taskSelection: Prisma.TaskWhereInput,
): Prisma.PersonWhereInput {
  const visiblePerson: Prisma.PersonWhereInput = {
    OR: [
      { status: "ACTIVE" },
      { workSegments: { some: segmentReadableWhere(actor) } },
    ],
  };
  if (selection.all) return visiblePerson;
  return {
    AND: [
      visiblePerson,
      {
        OR: [
          selection.personIds.length > 0
            ? { id: { in: selection.personIds } }
            : { id: { in: [] } },
          {
            taskMembers: {
              some: { removedAt: null, task: taskSelection },
            },
          },
          selection.projectIds.length > 0
            ? {
                projectMembers: {
                  some: {
                    projectId: { in: selection.projectIds },
                    removedAt: null,
                  },
                },
              }
            : { id: { in: [] } },
          selection.pinnedPersonIds.length > 0
            ? { id: { in: selection.pinnedPersonIds } }
            : { id: { in: [] } },
        ],
      },
    ],
  };
}

async function assertSelectionExists(
  actor: ProjectManagementActor,
  selection: Selection,
) {
  const taskSelection = taskSelectionWhere(actor, selection);
  const personSelection = personSelectionWhere(actor, selection, taskSelection);
  const [projectCount, taskCount, personCount, pinnedTaskCount, pinnedPersonCount] = await Promise.all([
    prisma.project.count({
      where: {
        AND: [projectReadableWhere(actor), { id: { in: selection.projectIds } }],
      },
    }),
    prisma.task.count({
      where: {
        AND: [taskReadableWhere(actor), { id: { in: selection.taskIds } }],
      },
    }),
    prisma.person.count({
      where: {
        id: { in: selection.personIds },
        OR: [
          { status: "ACTIVE" },
          { workSegments: { some: segmentReadableWhere(actor) } },
        ],
      },
    }),
    prisma.task.count({
      where: {
        AND: [
          taskReadableWhere(actor),
          { id: { in: selection.pinnedTaskIds } },
        ],
      },
    }),
    prisma.person.count({
      where: { AND: [personSelection, { id: { in: selection.pinnedPersonIds } }] },
    }),
  ]);
  if (
    projectCount !== selection.projectIds.length ||
    taskCount !== selection.taskIds.length ||
    personCount !== selection.personIds.length ||
    pinnedTaskCount !== selection.pinnedTaskIds.length ||
    pinnedPersonCount !== selection.pinnedPersonIds.length
  ) {
    throw notFoundError();
  }
  return { taskSelection, personSelection };
}
