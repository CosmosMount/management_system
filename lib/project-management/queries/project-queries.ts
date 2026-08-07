import type { Prisma, ProjectStatus, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  authorize,
  isSystemAdministrator,
  projectReadableWhere,
  type AuthorizationProjectResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { notFoundError } from "@/lib/project-management/application/errors";
import { normalizeSearchText, searchTerms } from "@/lib/search/normalize-search-text";
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";
import { resolveActiveProjectOptionsInputSchema, searchActiveProjectOptionsInputSchema } from "@/lib/project-management/validations/project";

const projectCardInclude = {
  members: {
    where: { removedAt: null, role: "OWNER" },
    include: { person: { select: { displayName: true, avatar: true, status: true } } },
    orderBy: [{ role: "asc" as const }, { createdAt: "asc" as const }],
  },
  _count: { select: { tasks: { where: { deletedAt: null } }, members: { where: { removedAt: null, role: "PARTICIPANT" } } } },
} satisfies Prisma.ProjectInclude;

const projectDetailTaskSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  lockVersion: true,
  activeMilestoneNodeId: true,
  createdAt: true,
  updatedAt: true,
  members: {
    where: { removedAt: null },
    orderBy: [{ role: "asc" as const }, { createdAt: "asc" as const }],
    select: {
      personId: true,
      role: true,
      person: { select: { displayName: true, avatar: true, status: true } },
    },
  },
  currentPlanVersion: {
    select: {
      versionNo: true,
      plannedStartAt: true,
      nodes: {
        where: { node: { deletedAt: null } },
        orderBy: { sequence: "asc" as const },
        select: {
          sequence: true,
          node: {
            select: {
              id: true,
              status: true,
              milestone: { select: { goal: true, expectedCompletedAt: true } },
              revision: { select: { reason: true, revisionAt: true, status: true } },
              termination: { select: { name: true, plannedAt: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.TaskSelect;

type ProjectDetailTaskRow = Prisma.TaskGetPayload<{
  select: typeof projectDetailTaskSelect;
}>;

const projectTaskStatusGroups = [
  ["DRAFT"],
  ["ACTIVE"],
  ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ARCHIVED"],
] as const satisfies ReadonlyArray<ReadonlyArray<TaskStatus>>;

type ProjectTaskStatusGroup = 0 | 1 | 2;

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

export async function getProjectDetail({
  actor,
  projectId,
  pagination,
}: {
  actor: ProjectManagementActor;
  projectId: string;
  pagination?: {
    taskCursor?: string;
    requestCursor?: string;
    auditCursor?: string;
    pageSize?: number;
  };
}) {
  const pageSize = Math.min(Math.max(pagination?.pageSize ?? 25, 1), 25);
  const taskCursor = decodeProjectTaskCursor(pagination?.taskCursor);
  const requestCursor = decodeRoundCursor(pagination?.requestCursor);
  const auditCursor = decodeTimestampCursor(pagination?.auditCursor);
  const project = await prisma.project.findFirst({
    where: { AND: [{ id: projectId }, projectReadableWhere(actor)] },
    include: {
      members: { where: { removedAt: null }, include: { person: { select: { displayName: true, avatar: true, status: true } } }, orderBy: [{ role: "asc" }, { createdAt: "asc" }] },
      _count: { select: { tasks: { where: { deletedAt: null } } } },
    },
  });
  if (!project) throw notFoundError();
  const [completedTaskTotalCount, blockingTasks, taskRows, requestRows, auditRows, pendingRequest] = await Promise.all([
    prisma.task.count({ where: { projectId: project.id, deletedAt: null, status: "COMPLETED" } }),
    prisma.task.findMany({ where: { projectId: project.id, deletedAt: null, status: { not: "COMPLETED" } }, select: { id: true, title: true, status: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 10 }),
    loadProjectDetailTaskRows(project.id, taskCursor, pageSize + 1),
    prisma.projectEstablishmentRequest.findMany({
      where: {
        projectId: project.id,
        ...(requestCursor
          ? {
              OR: [
                { round: { lt: requestCursor.round } },
                { round: requestCursor.round, id: { lt: requestCursor.id } },
              ],
            }
          : {}),
      },
      include: { submittedBy: { select: { person: { select: { displayName: true } } } }, reviewer: { select: { person: { select: { displayName: true } } } }, requestedTasks: { include: { task: { select: { id: true, title: true, status: true, lockVersion: true } } }, orderBy: { sortOrder: "asc" } } },
      orderBy: [{ round: "desc" }, { id: "desc" }],
      take: pageSize + 1,
    }),
    prisma.domainAuditEvent.findMany({
      where: {
        projectId: project.id,
        ...(auditCursor
          ? {
              OR: [
                { createdAt: { lt: auditCursor.timestamp } },
                { createdAt: auditCursor.timestamp, id: { lt: auditCursor.id } },
              ],
            }
          : {}),
      },
      select: { id: true, action: true, reason: true, createdAt: true, actorPerson: { select: { displayName: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: pageSize + 1,
    }),
    prisma.projectEstablishmentRequest.findFirst({ where: { projectId: project.id, status: "PENDING" }, select: { id: true } }),
  ]);
  const tasks = taskRows.slice(0, pageSize);
  const visiblePlanNodeCount = tasks.reduce(
    (count, task) => count + task.currentPlanVersion.nodes.length,
    0,
  );
  const oversizedTaskPlan = tasks.some(
    (task) => task.currentPlanVersion.nodes.length > 200,
  );
  const timelineError = oversizedTaskPlan
    ? "当前页存在超过 200 个节点的 Task，无法展示时间线。"
    : visiblePlanNodeCount > 5_000
      ? "当前页 Task 计划节点超过 5000 个，无法展示时间线。"
      : null;
  const requests = requestRows.slice(0, pageSize);
  const auditEvents = auditRows.slice(0, pageSize);
  const resource: AuthorizationProjectResource = { type: "project", id: project.id, status: project.status, requesterAccountId: project.requesterAccountId, members: project.members };
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    avatarPath: project.avatarPath,
    status: project.status,
    requesterAccountId: project.requesterAccountId,
    establishmentRound: project.establishmentRound,
    lockVersion: project.lockVersion,
    submittedAt: project.submittedAt.toISOString(),
    startedAt: project.startedAt?.toISOString() ?? null,
    completedAt: project.completedAt?.toISOString() ?? null,
    reviewedAt: project.reviewedAt?.toISOString() ?? null,
    reviewComment: project.reviewComment,
    members: project.members.map((member) => ({ personId: member.personId, role: member.role, displayName: member.person.displayName, avatar: member.person.avatar, status: member.person.status })),
    requests: requests.map((request) => ({ id: request.id, round: request.round, status: request.status, reviewComment: request.reviewComment, submittedAt: request.submittedAt.toISOString(), reviewedAt: request.reviewedAt?.toISOString() ?? null, submittedByName: request.submittedBy.person?.displayName ?? "未知用户", reviewerName: request.reviewer?.person?.displayName ?? null, tasks: request.requestedTasks.map((entry) => entry.task) })),
    requestNextCursor: requestRows.length > pageSize && requests.at(-1) ? encodeRoundCursor(requests.at(-1)!.round, requests.at(-1)!.id) : null,
    pendingRequestId: pendingRequest?.id ?? null,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      lockVersion: task.lockVersion,
      activeMilestoneNodeId: task.activeMilestoneNodeId,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      members: task.members.map((member) => ({
        personId: member.personId,
        role: member.role,
        displayName: member.person.displayName,
        avatar: member.person.avatar,
        status: member.person.status,
      })),
      currentPlan: {
        versionNo: task.currentPlanVersion.versionNo,
        plannedStartAt: task.currentPlanVersion.plannedStartAt?.toISOString() ?? null,
        nodes: timelineError ? [] : task.currentPlanVersion.nodes.map((entry) => ({
          id: entry.node.id,
          sequence: entry.sequence,
          status: entry.node.status,
          milestone: entry.node.milestone
            ? {
                goal: entry.node.milestone.goal,
                expectedCompletedAt: entry.node.milestone.expectedCompletedAt.toISOString(),
              }
            : null,
          revision: entry.node.revision
            ? {
                reason: entry.node.revision.reason,
                revisionAt: entry.node.revision.revisionAt.toISOString(),
                status: entry.node.revision.status,
              }
            : null,
          termination: entry.node.termination
            ? {
                name: entry.node.termination.name,
                plannedAt: entry.node.termination.plannedAt.toISOString(),
              }
            : null,
        })),
      },
    })),
    taskNextCursor:
      taskRows.length > pageSize && tasks.at(-1)
        ? encodeProjectTaskCursor(tasks.at(-1)!)
        : null,
    timelineError,
    taskTotalCount: project._count.tasks,
    completedTaskTotalCount,
    blockingTasks,
    auditEvents: auditEvents.map((event) => ({ id: event.id, action: event.action, reason: event.reason, actorName: event.actorPerson?.displayName ?? "系统", createdAt: event.createdAt.toISOString() })),
    auditNextCursor: auditRows.length > pageSize && auditEvents.at(-1) ? encodeTimestampCursor(auditEvents.at(-1)!.createdAt, auditEvents.at(-1)!.id) : null,
    permissions: {
      canReview: project.status === "PENDING_APPROVAL" && authorize({ actor, action: "project.review_establishment", resource }).allowed,
      canEdit: (project.status === "ACTIVE" || project.status === "DRAFT") && authorize({ actor, action: "project.update", resource }).allowed,
      canResubmit: project.status === "DRAFT" && authorize({ actor, action: "project.submit_establishment", resource }).allowed,
      canComplete: project.status === "ACTIVE" && authorize({ actor, action: "project.complete", resource }).allowed,
      canDelete: project.status !== "COMPLETED" && authorize({ actor, action: "project.delete", resource }).allowed,
    },
  };
}

export type ProjectOption = { id: string; name: string; avatarPath: string | null };
export type ProjectOptionPage = { items: ProjectOption[]; nextCursor: string | null; hasMoreByQuery: boolean };

export async function listActiveProjectOptions(currentProjectId?: string | null) {
  const active = await prisma.project.findMany({ where: { status: "ACTIVE", deletedAt: null }, select: { id: true, name: true, avatarPath: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 50 });
  if (!currentProjectId || active.some((project) => project.id === currentProjectId)) return active;
  const current = await prisma.project.findFirst({ where: { id: currentProjectId, deletedAt: null }, select: { id: true, name: true, avatarPath: true } });
  return current ? [current, ...active] : active;
}

export async function searchActiveProjectOptions(input: unknown): Promise<ProjectOptionPage> {
  const parsed = searchActiveProjectOptionsInputSchema.parse(input);
  const query = normalizeSearchText(parsed.query);
  const where: Prisma.ProjectWhereInput = { status: "ACTIVE", deletedAt: null };
  if (query) {
    const direct = await prisma.project.findMany({ where: { AND: [where, ...searchTerms(query).map((term) => ({ name: { contains: term, mode: "insensitive" as const } }))] }, select: { id: true, name: true, avatarPath: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 501 });
    const fallback = direct.length < 50 ? await prisma.project.findMany({ where, select: { id: true, name: true, avatarPath: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 501 }) : [];
    const candidates = [...new Map([...direct, ...fallback].map((item) => [item.id, item])).values()];
    const ranked = rankFuzzyMatches(candidates, query, (item) => [{ text: item.name, weight: 2, pinyin: true }], (left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));
    return { items: ranked.slice(0, parsed.limit).map(({ item }) => item), nextCursor: null, hasMoreByQuery: ranked.length > parsed.limit || direct.length === 501 || fallback.length === 501 };
  }
  const rows = await prisma.project.findMany({ where, select: { id: true, name: true, avatarPath: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: parsed.limit + 1, ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}) });
  const items = rows.slice(0, parsed.limit);
  return { items, nextCursor: rows.length > parsed.limit ? items.at(-1)?.id ?? null : null, hasMoreByQuery: false };
}

export async function resolveActiveProjectOptions(input: unknown): Promise<ProjectOption[]> {
  const parsed = resolveActiveProjectOptionsInputSchema.parse(input);
  const rows = await prisma.project.findMany({ where: { id: { in: parsed.ids }, status: "ACTIVE", deletedAt: null }, select: { id: true, name: true, avatarPath: true } });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return parsed.ids.flatMap((id) => byId.get(id) ?? []);
}

function projectListItem(project: Prisma.ProjectGetPayload<{ include: typeof projectCardInclude }>, completedTaskCount: number): ProjectListItem {
  return { id: project.id, name: project.name, description: project.description, avatarPath: project.avatarPath, status: project.status, owners: project.members.map((member) => ({ personId: member.personId, displayName: member.person.displayName, avatar: member.person.avatar })), participantCount: project._count.members, taskCount: project._count.tasks, completedTaskCount, updatedAt: project.updatedAt.toISOString() };
}

export function actorCanReviewProjects(actor: ProjectManagementActor) { return isSystemAdministrator(actor); }

type ProjectTaskCursor = {
  group: ProjectTaskStatusGroup;
  timestamp: Date;
  id: string;
};

async function loadProjectDetailTaskRows(
  projectId: string,
  cursor: ProjectTaskCursor | null,
  limit: number,
): Promise<ProjectDetailTaskRow[]> {
  const rows: ProjectDetailTaskRow[] = [];
  const firstGroup = cursor?.group ?? 0;
  for (let group = firstGroup; group < projectTaskStatusGroups.length; group += 1) {
    const statusGroup = group as ProjectTaskStatusGroup;
    const remaining = limit - rows.length;
    if (remaining <= 0) break;
    const groupCursor = cursor?.group === statusGroup ? cursor : null;
    const groupRows = await prisma.task.findMany({
      where: {
        projectId,
        deletedAt: null,
        status: { in: [...projectTaskStatusGroups[statusGroup]] },
        ...(groupCursor
          ? {
              OR: [
                { updatedAt: { lt: groupCursor.timestamp } },
                {
                  updatedAt: groupCursor.timestamp,
                  id: { gt: groupCursor.id },
                },
              ],
            }
          : {}),
      },
      select: projectDetailTaskSelect,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: remaining,
    });
    rows.push(...groupRows);
  }
  return rows;
}

function projectTaskStatusGroup(status: TaskStatus): ProjectTaskStatusGroup {
  if (status === "DRAFT") return 0;
  if (status === "ACTIVE") return 1;
  return 2;
}

function encodeProjectTaskCursor(
  task: Pick<ProjectDetailTaskRow, "id" | "status" | "updatedAt">,
) {
  return Buffer.from(
    JSON.stringify({
      group: projectTaskStatusGroup(task.status),
      timestamp: task.updatedAt.toISOString(),
      id: task.id,
    }),
  ).toString("base64url");
}

function decodeProjectTaskCursor(value: string | undefined): ProjectTaskCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      group?: unknown;
      timestamp?: unknown;
      id?: unknown;
    };
    const timestamp =
      typeof parsed.timestamp === "string" ? new Date(parsed.timestamp) : null;
    if (
      (parsed.group !== 0 && parsed.group !== 1 && parsed.group !== 2) ||
      !timestamp ||
      Number.isNaN(timestamp.getTime()) ||
      typeof parsed.id !== "string" ||
      !parsed.id
    ) {
      return null;
    }
    return { group: parsed.group, timestamp, id: parsed.id };
  } catch {
    return null;
  }
}

function encodeTimestampCursor(timestamp: Date, id: string) {
  return Buffer.from(JSON.stringify({ timestamp: timestamp.toISOString(), id })).toString("base64url");
}

function decodeTimestampCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { timestamp?: unknown; id?: unknown };
    const timestamp = typeof parsed.timestamp === "string" ? new Date(parsed.timestamp) : null;
    return timestamp && !Number.isNaN(timestamp.getTime()) && typeof parsed.id === "string" && parsed.id
      ? { timestamp, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

function encodeRoundCursor(round: number, id: string) {
  return Buffer.from(JSON.stringify({ round, id })).toString("base64url");
}

function decodeRoundCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { round?: unknown; id?: unknown };
    return Number.isInteger(parsed.round) && typeof parsed.id === "string" && parsed.id
      ? { round: parsed.round as number, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}
