import type { Prisma, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validationError } from "@/lib/project-management/application/errors";
import {
  isSystemAdministrator,
  taskReadableWhere,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  cursorFilter,
  FUZZY_CANDIDATE_LIMIT,
  mergeRowsById,
  nextOptionCursor,
  QUERY_RESULT_LIMIT,
  validateOptionCursor,
} from "@/lib/project-management/queries/option-query-support";
import {
  taskOptionPageSchema,
  type TaskOptionPage,
} from "@/lib/project-management/types/time-canvas";
import {
  resolveTaskOptionsByIdsInputSchema,
  searchTaskOptionsInputSchema,
} from "@/lib/project-management/validations/time-canvas";
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";
import {
  normalizeSearchText,
  searchTerms,
} from "@/lib/search/normalize-search-text";

const taskOptionSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  team: true,
  techGroup: true,
  activeMilestoneNode: {
    select: {
      id: true,
      milestone: {
        select: { goal: true, expectedCompletedAt: true },
      },
    },
  },
  currentPlanVersion: {
    select: {
      versionNo: true,
      nodes: {
        where: {
          node: { type: "TERMINATION", status: "ACTIVE", deletedAt: null },
        },
        take: 1,
        select: {
          node: {
            select: {
              id: true,
              termination: { select: { name: true, plannedAt: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.TaskSelect;

type TaskOptionRow = Prisma.TaskGetPayload<{
  select: typeof taskOptionSelect;
}>;

export async function searchTaskOptions({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}): Promise<TaskOptionPage> {
  const parsed = searchTaskOptionsInputSchema.parse(input);
  const query = normalizeSearchText(parsed.query ?? "");
  const statuses = [...parsed.statuses].sort();
  const baseWhere: Prisma.TaskWhereInput = {
    AND: [
      taskReadableWhere(actor),
      statuses.length > 0 ? { status: { in: statuses } } : {},
      parsed.mine ? myTaskOptionWhere(actor) : {},
      parsed.projectCandidates ? projectEstablishmentTaskCandidateWhere(actor) : {},
    ],
  };
  if (query) {
    if (parsed.cursor) {
      throw validationError("非空 Task 搜索不支持分页游标，请继续输入关键词", {
        cursor: ["非空 Task 搜索不支持分页游标，请继续输入关键词"],
      });
    }
    const directRows = await prisma.task.findMany({
      where: {
        AND: [
          baseWhere,
          ...searchTerms(query).map((term) => ({
            OR: [
              { title: { contains: term, mode: "insensitive" as const } },
              { description: { contains: term, mode: "insensitive" as const } },
            ],
          })),
        ],
      },
      select: taskOptionSelect,
      orderBy: [{ title: "asc" }, { id: "asc" }],
      take: FUZZY_CANDIDATE_LIMIT,
    });
    const fallbackRows =
      directRows.length < QUERY_RESULT_LIMIT
        ? await prisma.task.findMany({
            where: baseWhere,
            select: taskOptionSelect,
            orderBy: [{ title: "asc" }, { id: "asc" }],
            take: FUZZY_CANDIDATE_LIMIT,
          })
        : [];
    const ranked = rankFuzzyMatches(
      mergeRowsById(directRows, fallbackRows),
      query,
      (task) => [
        { text: task.title, weight: 2, pinyin: true },
        { text: task.description, weight: 1 },
      ],
      compareTaskRows,
    );
    const resultLimit = Math.min(parsed.limit, QUERY_RESULT_LIMIT);
    return taskOptionPageSchema.parse({
      items: ranked.slice(0, resultLimit).map(({ item }) => taskOption(item)),
      nextCursor: null,
      hasMoreByQuery:
        ranked.length > resultLimit ||
        directRows.length === FUZZY_CANDIDATE_LIMIT ||
        fallbackRows.length === FUZZY_CANDIDATE_LIMIT,
    });
  }
  const where = baseWhere;
  const filter = cursorFilter({ query, statuses, mine: parsed.mine, projectCandidates: parsed.projectCandidates });
  const cursorId = await validateOptionCursor({
    cursor: parsed.cursor,
    kind: "tasks",
    filter,
    exists: (id) =>
      prisma.task.findFirst({ where: { AND: [{ id }, where] }, select: { id: true } }),
  });
  const rows = await prisma.task.findMany({
    where,
    select: taskOptionSelect,
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: parsed.limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
  const items = rows.slice(0, parsed.limit).map(taskOption);
  return taskOptionPageSchema.parse({
    items,
    nextCursor:
      rows.length > parsed.limit
        ? nextOptionCursor("tasks", filter, items.at(-1)?.id)
        : null,
    hasMoreByQuery: false,
  });
}

export async function listMyTaskOptions({
  actor,
  statuses,
}: {
  actor: ProjectManagementActor;
  statuses: readonly TaskStatus[];
}): Promise<TaskOptionPage["items"]> {
  return listTaskOptionsByScope({
    actor,
    statuses,
    scope: myTaskOptionWhere(actor),
  });
}

export async function listPersonTaskOptions({
  actor,
  personId,
  statuses,
}: {
  actor: ProjectManagementActor;
  personId: string;
  statuses: readonly TaskStatus[];
}): Promise<TaskOptionPage["items"]> {
  return listTaskOptionsByScope({
    actor,
    statuses,
    scope: {
      members: {
        some: { personId, removedAt: null },
      },
    },
  });
}

async function listTaskOptionsByScope({
  actor,
  statuses,
  scope,
}: {
  actor: ProjectManagementActor;
  statuses: readonly TaskStatus[];
  scope: Prisma.TaskWhereInput;
}): Promise<TaskOptionPage["items"]> {
  const rows = await prisma.task.findMany({
    where: {
      AND: [
        taskReadableWhere(actor),
        statuses.length > 0 ? { status: { in: [...statuses] } } : {},
        scope,
      ],
    },
    select: taskOptionSelect,
    orderBy: [{ title: "asc" }, { id: "asc" }],
  });
  return rows.map(taskOption);
}

export async function resolveTaskOptionsByIds({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input: unknown;
}): Promise<TaskOptionPage["items"]> {
  const parsed = resolveTaskOptionsByIdsInputSchema.parse(input);
  if (parsed.ids.length === 0) return [];
  const rows = await prisma.task.findMany({
    where: { AND: [{ id: { in: parsed.ids } }, taskReadableWhere(actor), parsed.projectCandidates ? projectEstablishmentTaskCandidateWhere(actor) : {}] },
    select: taskOptionSelect,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return parsed.ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [taskOption(row)] : [];
  });
}

function projectEstablishmentTaskCandidateWhere(actor: ProjectManagementActor): Prisma.TaskWhereInput {
  return {
    projectId: null,
    ...(isSystemAdministrator(actor)
      ? {}
      : {
          OR: [
            {
              members: {
                some: {
                  personId: actor.personId,
                  role: { in: ["OWNER", "PARTICIPANT"] },
                  removedAt: null,
                },
              },
            },
            { status: "DRAFT", createdByAccountId: actor.accountId },
          ],
        }),
  };
}

function myTaskOptionWhere(actor: ProjectManagementActor): Prisma.TaskWhereInput {
  return {
    OR: [
      {
        members: {
          some: { personId: actor.personId, removedAt: null },
        },
      },
      { status: "DRAFT", createdByAccountId: actor.accountId },
    ],
  };
}

function taskOption(task: TaskOptionRow) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    team: task.team,
    techGroup: task.techGroup,
    activeMilestone:
      task.activeMilestoneNode?.milestone
        ? {
            nodeId: task.activeMilestoneNode.id,
            goal: task.activeMilestoneNode.milestone.goal,
            expectedCompletedAt:
              task.activeMilestoneNode.milestone.expectedCompletedAt.toISOString(),
          }
        : null,
    activeTermination: task.currentPlanVersion.nodes[0]?.node.termination
      ? {
          nodeId: task.currentPlanVersion.nodes[0].node.id,
          name: task.currentPlanVersion.nodes[0].node.termination.name,
          plannedAt:
            task.currentPlanVersion.nodes[0].node.termination.plannedAt.toISOString(),
        }
      : null,
    currentPlanVersionNo: task.currentPlanVersion.versionNo,
    permission: { canView: true },
  };
}

function compareTaskRows(left: TaskOptionRow, right: TaskOptionRow) {
  const activeOrder =
    Number(right.status === "ACTIVE") - Number(left.status === "ACTIVE");
  return (
    activeOrder ||
    left.title.localeCompare(right.title, "zh-CN") ||
    left.id.localeCompare(right.id)
  );
}
