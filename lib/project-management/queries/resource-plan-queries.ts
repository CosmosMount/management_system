import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  projectReadableWhere,
  segmentReadableWhere,
  taskReadableWhere,
} from "@/lib/project-management/authorization";
import { notFoundError, validationError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

const idList = z.array(z.string().uuid()).max(50).default([]).transform((ids) =>
  [...new Set(ids)].sort(),
);
const pinnedIdList = z.array(z.string().uuid()).max(1).default([]).transform((ids) =>
  [...new Set(ids)],
);

const resourcePlanExplicitIdsSchema = z.object({
  projectIds: idList,
  taskIds: idList,
  personIds: idList,
}).strict();

const resourcePlanSelectionSchema = resourcePlanExplicitIdsSchema.extend({
  all: z.boolean().default(true),
  pinnedTaskIds: pinnedIdList,
  pinnedPersonIds: pinnedIdList,
  taskCursor: z.string().trim().min(1).max(500).optional(),
  personCursor: z.string().trim().min(1).max(500).optional(),
}).strict();

type Selection = z.infer<typeof resourcePlanSelectionSchema>;

export async function getResourcePlanSelectionPage({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}) {
  const selection = resourcePlanSelectionSchema.parse(input);
  const { taskSelection, personSelection } = await assertSelectionExists(actor, selection);
  const signature = selectionSignature(selection);
  const [taskCursorId, personCursorId] = [
    decodeCursor(selection.taskCursor, "TASK", signature),
    decodeCursor(selection.personCursor, "PERSON", signature),
  ];
  await assertCursorsBelongToSelection({
    taskCursorId,
    personCursorId,
    taskSelection,
    personSelection,
  });
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
      nextTaskCursor: null,
      nextPersonCursor: null,
      selectionSignature: signature,
    };
  }

  const pinnedTaskPageIds = taskCursorId ? [] : selection.pinnedTaskIds;
  const pinnedPersonPageIds = personCursorId ? [] : selection.pinnedPersonIds;
  const taskPageSize = 25 - pinnedTaskPageIds.length;
  const personPageSize = 50 - pinnedPersonPageIds.length;
  const [tasks, people] = await Promise.all([
    prisma.task.findMany({
      where: { AND: [taskSelection, { id: { notIn: selection.pinnedTaskIds } }] },
      select: { id: true },
      orderBy: [{ title: "asc" }, { id: "asc" }],
      take: taskPageSize + 1,
      ...(taskCursorId ? { cursor: { id: taskCursorId }, skip: 1 } : {}),
    }),
    prisma.person.findMany({
      where: { AND: [personSelection, { id: { notIn: selection.pinnedPersonIds } }] },
      select: { id: true },
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
      take: personPageSize + 1,
      ...(personCursorId ? { cursor: { id: personCursorId }, skip: 1 } : {}),
    }),
  ]);
  const taskPage = tasks.slice(0, taskPageSize);
  const personPage = people.slice(0, personPageSize);
  return {
    taskIds: [...pinnedTaskPageIds, ...taskPage.map((task) => task.id)],
    personIds: [...pinnedPersonPageIds, ...personPage.map((person) => person.id)],
    nextTaskCursor: tasks.length > taskPageSize
      ? encodeCursor("TASK", signature, taskPage.at(-1)?.id)
      : null,
    nextPersonCursor: people.length > personPageSize
      ? encodeCursor("PERSON", signature, personPage.at(-1)?.id)
      : null,
    selectionSignature: signature,
  };
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
      where: { AND: [taskSelection, { id: { in: selection.pinnedTaskIds } }] },
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

async function assertCursorsBelongToSelection({
  taskCursorId,
  personCursorId,
  taskSelection,
  personSelection,
}: {
  taskCursorId: string | null;
  personCursorId: string | null;
  taskSelection: Prisma.TaskWhereInput;
  personSelection: Prisma.PersonWhereInput;
}) {
  const [taskCursor, personCursor] = await Promise.all([
    taskCursorId
      ? prisma.task.findFirst({
          where: { AND: [taskSelection, { id: taskCursorId }] },
          select: { id: true },
        })
      : null,
    personCursorId
      ? prisma.person.findFirst({
          where: { AND: [personSelection, { id: personCursorId }] },
          select: { id: true },
        })
      : null,
  ]);
  if ((taskCursorId && !taskCursor) || (personCursorId && !personCursor)) {
    throw validationError("资源计划分页游标无效或选择条件已变化");
  }
}

function selectionSignature(selection: Selection) {
  return createHash("sha256").update(JSON.stringify({
    all: selection.all,
    projectIds: selection.projectIds,
    taskIds: selection.taskIds,
    personIds: selection.personIds,
    pinnedTaskIds: selection.pinnedTaskIds,
    pinnedPersonIds: selection.pinnedPersonIds,
  })).digest("base64url").slice(0, 24);
}

function encodeCursor(
  kind: "TASK" | "PERSON",
  signature: string,
  id: string | undefined,
) {
  if (!id) return null;
  return Buffer.from(JSON.stringify({ v: 1, kind, signature, id }), "utf8")
    .toString("base64url");
}

function decodeCursor(
  value: string | undefined,
  kind: "TASK" | "PERSON",
  signature: string,
) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v?: unknown;
      kind?: unknown;
      signature?: unknown;
      id?: unknown;
    };
    if (
      parsed.v !== 1 ||
      parsed.kind !== kind ||
      parsed.signature !== signature ||
      typeof parsed.id !== "string" ||
      !z.string().uuid().safeParse(parsed.id).success
    ) {
      throw new Error("invalid");
    }
    return parsed.id;
  } catch {
    throw validationError("资源计划分页游标无效或选择条件已变化");
  }
}
