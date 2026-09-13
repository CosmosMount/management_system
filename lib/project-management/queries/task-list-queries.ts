import type { Prisma, TaskPriority, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveCurrentNodeDeadline } from "@/lib/project-management/current-node-deadline";
import { currentDeadlinePlanNodesSelect } from "@/lib/project-management/queries/current-node-deadline-select";
import { taskReadableWhere } from "@/lib/project-management/authorization";
import { validationError } from "@/lib/project-management/application/errors";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "@/lib/project-management/queries/keyset-cursor";
import type { TaskListResult } from "@/lib/project-management/queries/task-query-types";
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";
import {
  normalizeSearchText,
  searchTerms,
} from "@/lib/search/normalize-search-text";

const taskListInclude = {
  project: { select: { id: true, name: true, avatarPath: true } },
  currentPlanVersion: {
    select: {
      versionNo: true,
      nodes: currentDeadlinePlanNodesSelect,
    },
  },
  activeMilestoneNode: {
    include: {
      milestone: true,
    },
  },
  members: {
    where: { removedAt: null },
    include: { person: { select: { displayName: true, avatar: true, status: true } } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  },
} satisfies Prisma.TaskInclude;

export async function listTasks({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input?: {
    status?: TaskStatus;
    priority?: TaskPriority;
    mine?: boolean;
    query?: string;
    cursor?: string;
    limit?: number;
  };
}): Promise<TaskListResult> {
  const limit = Math.min(Math.max(input?.limit ?? 30, 1), 100);
  const query = normalizeSearchText(input?.query ?? "");
  const filters: Prisma.TaskWhereInput[] = [
    taskReadableWhere(actor),
    input?.status ? { status: input.status } : {},
    input?.priority ? { priority: input.priority } : {},
    input?.mine
      ? {
          OR: [
            {
              members: {
                some: { personId: actor.personId, removedAt: null },
              },
            },
            { status: "DRAFT", createdByAccountId: actor.accountId },
          ],
        }
      : {},
  ];
  const where: Prisma.TaskWhereInput = { AND: filters };
  const cursorScope = JSON.stringify({
    accountId: actor.accountId,
    status: input?.status ?? null,
    priority: input?.priority ?? null,
    mine: input?.mine ?? false,
  });
  let hasMoreByQuery = false;
  let hasNextPage = false;
  let visibleTasks: Prisma.TaskGetPayload<{ include: typeof taskListInclude }>[];
  if (query) {
    const candidateSelect = { id: true, title: true, description: true, status: true } as const;
    const directCandidates = await prisma.task.findMany({
      where: {
        AND: [
          where,
          ...searchTerms(query).map((term) => ({
            OR: [
              { title: { contains: term, mode: "insensitive" as const } },
              { description: { contains: term, mode: "insensitive" as const } },
            ],
          })),
        ],
      },
      select: candidateSelect,
      orderBy: [{ title: "asc" }, { id: "asc" }],
      take: 501,
    });
    const fallbackCandidates = directCandidates.length < 50
      ? await prisma.task.findMany({
          where,
          select: candidateSelect,
          orderBy: [{ title: "asc" }, { id: "asc" }],
          take: 501,
        })
      : [];
    const candidates = [...new Map(
      [...directCandidates, ...fallbackCandidates].map((task) => [task.id, task]),
    ).values()];
    const ranked = rankFuzzyMatches(
      candidates,
      query,
      (task) => [
        { text: task.title, weight: 2, pinyin: true },
        { text: task.description, weight: 1 },
      ],
      (left, right) =>
        Number(right.status === "ACTIVE") - Number(left.status === "ACTIVE") ||
        left.title.localeCompare(right.title, "zh-CN") ||
        left.id.localeCompare(right.id),
    );
    const resultLimit = Math.min(limit, 50);
    const orderedIds = ranked.slice(0, resultLimit).map(({ item }) => item.id);
    const rows = orderedIds.length
      ? await prisma.task.findMany({
          where: { AND: [where, { id: { in: orderedIds } }] },
          include: taskListInclude,
        })
      : [];
    const byId = new Map(rows.map((task) => [task.id, task]));
    visibleTasks = orderedIds.flatMap((id) => {
      const task = byId.get(id);
      return task ? [task] : [];
    });
    hasMoreByQuery =
      ranked.length > resultLimit ||
      directCandidates.length === 501 ||
      fallbackCandidates.length === 501;
  } else {
    const cursor = decodeKeysetCursor(
      input?.cursor,
      "TASK",
      cursorScope,
      "Task 分页游标无效",
    );
    if (cursor) {
      const anchor = await prisma.task.findFirst({
        where: {
          AND: [where, { id: cursor.id, updatedAt: cursor.timestamp }],
        },
        select: { id: true },
      });
      if (!anchor) throw validationError("Task 分页游标无效");
    }
    const tasks = await prisma.task.findMany({
      where: {
        AND: [
          where,
          cursor
            ? {
                OR: [
                  { updatedAt: { lt: cursor.timestamp } },
                  { updatedAt: cursor.timestamp, id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      include: taskListInclude,
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    visibleTasks = tasks.slice(0, limit);
    hasNextPage = tasks.length > limit;
  }
  return {
    items: visibleTasks.map((task) => {
      const terminationNode = task.currentPlanVersion.nodes.find((entry) => entry.node.type === "TERMINATION")?.node;
      return {
        currentNodeDeadline: resolveCurrentNodeDeadline({
          taskStatus: task.status,
          activeMilestoneNodeId: task.activeMilestoneNodeId,
          nodes: task.currentPlanVersion.nodes.map((entry) => entry.node),
        }),
        id: task.id,
        title: task.title,
        description: task.description,
        team: task.team,
        techGroup: task.techGroup,
        status: task.status,
        priority: task.priority,
        project: task.project,
        currentPlanVersionNo: task.currentPlanVersion.versionNo,
        lockVersion: task.lockVersion,
        activeMilestone:
          task.activeMilestoneNode?.milestone
            ? {
                nodeId: task.activeMilestoneNode.id,
                goal: task.activeMilestoneNode.milestone.goal,
                expectedCompletedAt:
                  task.activeMilestoneNode.milestone.expectedCompletedAt.toISOString(),
              }
            : null,
        activeTermination: terminationNode?.termination
          ? {
              nodeId: terminationNode.id,
              name: terminationNode.termination.name,
              plannedAt: terminationNode.termination.plannedAt.toISOString(),
            }
          : null,
        members: task.members.map((member) => ({
          personId: member.personId,
          role: member.role,
          displayName: member.person.displayName,
          avatar: member.person.avatar,
          status: member.person.status,
        })),
        updatedAt: task.updatedAt.toISOString(),
        createdAt: task.createdAt.toISOString(),
      };
    }),
    nextCursor: hasNextPage
      ? encodeKeysetCursor(
          "TASK",
          cursorScope,
          visibleTasks.at(-1)
            ? {
                timestamp: visibleTasks.at(-1)!.updatedAt,
                id: visibleTasks.at(-1)!.id,
              }
            : undefined,
        )
      : null,
    hasMoreByQuery,
  };
}
