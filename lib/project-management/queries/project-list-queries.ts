import type { Prisma, ProjectStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { projectReadableWhere } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  decodeTimestampCursor,
  encodeTimestampCursor,
} from "@/lib/project-management/queries/project-query-support";
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";
import {
  normalizeSearchText,
  searchTerms,
} from "@/lib/search/normalize-search-text";

const projectCardInclude = {
  members: {
    where: { removedAt: null, role: "OWNER" },
    include: { person: { select: { displayName: true, avatar: true, status: true } } },
    orderBy: [{ role: "asc" as const }, { createdAt: "asc" as const }],
  },
  _count: { select: { tasks: { where: { deletedAt: null } }, members: { where: { removedAt: null, role: "PARTICIPANT" } } } },
} satisfies Prisma.ProjectInclude;

export type ProjectListItem = {
  id: string;
  name: string;
  description: string;
  avatarPath: string | null;
  status: ProjectStatus;
  owners: Array<{ personId: string; displayName: string; avatar: string | null }>;
  participantCount: number;
  taskCount: number;
  completedTaskCount: number;
  updatedAt: string;
};

export async function listProjects({
  actor,
  input,
}: {
  actor: ProjectManagementActor;
  input?: { status?: ProjectStatus; mine?: boolean; query?: string; limit?: number; cursor?: string };
}) {
  const limit = Math.min(Math.max(input?.limit ?? 50, 1), 100);
  const query = normalizeSearchText(input?.query ?? "");
  const where: Prisma.ProjectWhereInput = {
    AND: [
      projectReadableWhere(actor),
      input?.status ? { status: input.status } : {},
      input?.mine
        ? {
            OR: [
              { requesterAccountId: actor.accountId },
              { members: { some: { personId: actor.personId, removedAt: null } } },
            ],
          }
        : {},
    ],
  };
  let hasMoreByQuery = false;
  let hasMoreUnfiltered = false;
  let rows: Prisma.ProjectGetPayload<{ include: typeof projectCardInclude }>[];
  if (query) {
    const direct = await prisma.project.findMany({
      where: {
        AND: [
          where,
          ...searchTerms(query).map((term) => ({
            OR: [
              { name: { contains: term, mode: "insensitive" as const } },
              { description: { contains: term, mode: "insensitive" as const } },
            ],
          })),
        ],
      },
      select: { id: true, name: true, description: true, status: true },
      take: 501,
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const fallback = direct.length < 50
      ? await prisma.project.findMany({ where, select: { id: true, name: true, description: true, status: true }, take: 501, orderBy: [{ name: "asc" }, { id: "asc" }] })
      : [];
    const candidates = [...new Map([...direct, ...fallback].map((item) => [item.id, item])).values()];
    const ranked = rankFuzzyMatches(candidates, query, (item) => [{ text: item.name, weight: 2, pinyin: true }, { text: item.description, weight: 1 }], (left, right) => Number(right.status === "ACTIVE") - Number(left.status === "ACTIVE") || left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));
    const ids = ranked.slice(0, Math.min(limit, 50)).map(({ item }) => item.id);
    const unordered = ids.length ? await prisma.project.findMany({ where: { AND: [where, { id: { in: ids } }] }, include: projectCardInclude }) : [];
    const byId = new Map(unordered.map((row) => [row.id, row]));
    rows = ids.flatMap((id) => byId.get(id) ?? []);
    hasMoreByQuery = ranked.length > ids.length || direct.length === 501 || fallback.length === 501;
  } else {
    const cursor = decodeTimestampCursor(input?.cursor);
    const pageRows = await prisma.project.findMany({
      where: {
        AND: [
          where,
          cursor
            ? {
                OR: [
                  { updatedAt: { lt: cursor.timestamp } },
                  { updatedAt: cursor.timestamp, id: { gt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      include: projectCardInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: limit + 1,
    });
    hasMoreUnfiltered = pageRows.length > limit;
    rows = pageRows.slice(0, limit);
  }
  const completedCounts = rows.length
    ? await prisma.task.groupBy({ by: ["projectId"], where: { projectId: { in: rows.map((row) => row.id) }, deletedAt: null, status: "COMPLETED" }, _count: { _all: true } })
    : [];
  const completedByProject = new Map(completedCounts.flatMap((entry) => entry.projectId ? [[entry.projectId, entry._count._all] as const] : []));
  const lastProject = rows.at(-1);
  return {
    items: rows.map((project) => projectListItem(project, completedByProject.get(project.id) ?? 0)),
    hasMoreByQuery,
    nextCursor:
      !query && hasMoreUnfiltered && lastProject
        ? encodeTimestampCursor(lastProject.updatedAt, lastProject.id)
        : null,
  };
}

function projectListItem(project: Prisma.ProjectGetPayload<{ include: typeof projectCardInclude }>, completedTaskCount: number): ProjectListItem {
  return { id: project.id, name: project.name, description: project.description, avatarPath: project.avatarPath, status: project.status, owners: project.members.map((member) => ({ personId: member.personId, displayName: member.person.displayName, avatar: member.person.avatar })), participantCount: project._count.members, taskCount: project._count.tasks, completedTaskCount, updatedAt: project.updatedAt.toISOString() };
}
