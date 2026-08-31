import type { Prisma, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notFoundError } from "@/lib/project-management/application/errors";
import {
  authorize,
  isSystemAdministrator,
  projectReadableWhere,
  type AuthorizationProjectResource,
} from "@/lib/project-management/authorization";
import { PROJECT_COMPLETION_BLOCKING_TASK_STATUSES } from "@/lib/project-management/domain/project-lifecycle";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  decodeTimestampCursor,
  encodeTimestampCursor,
} from "@/lib/project-management/queries/project-query-support";

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

export async function getProjectDetail({
  actor,
  projectId,
  pagination,
}: {
  actor: ProjectManagementActor;
  projectId: string;
  pagination?: {
    requestCursor?: string;
    auditCursor?: string;
    pageSize?: number;
  };
}) {
  const pageSize = Math.min(Math.max(pagination?.pageSize ?? 25, 1), 25);
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
  const [blockingTaskTotalCount, blockingTasks, taskRows, requestRows, auditRows, pendingRequest] = await Promise.all([
    prisma.task.count({ where: { projectId: project.id, deletedAt: null, status: { in: [...PROJECT_COMPLETION_BLOCKING_TASK_STATUSES] } } }),
    prisma.task.findMany({ where: { projectId: project.id, deletedAt: null, status: { in: [...PROJECT_COMPLETION_BLOCKING_TASK_STATUSES] } }, select: { id: true, title: true, status: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], take: 10 }),
    loadProjectDetailTaskRows(project.id),
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
  const tasks = taskRows;
  const completedTaskTotalCount = tasks.filter(
    (task) => task.status === "COMPLETED",
  ).length;
  const completionTaskTotalCount = tasks.filter(
    (task) => task.status !== "CANCELLED",
  ).length;
  const visiblePlanNodeCount = tasks.reduce(
    (count, task) => count + task.currentPlanVersion.nodes.length,
    0,
  );
  const timelineError = visiblePlanNodeCount > 5_000
    ? "Project Task 计划节点超过 5000 个，无法展示时间线。"
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
    timelineError,
    taskTotalCount: project._count.tasks,
    completionTaskTotalCount,
    completedTaskTotalCount,
    blockingTaskTotalCount,
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

export async function locateProjectTimelineFocus({
  actor,
  projectId,
  focus,
}: {
  actor: ProjectManagementActor;
  projectId: string;
  focus: string;
}) {
  const project = await prisma.project.findFirst({
    where: { AND: [{ id: projectId }, projectReadableWhere(actor)] },
    select: { id: true },
  });
  if (!project) throw notFoundError();
  const token = parseProjectTimelineFocus(focus);
  if (!token) return null;
  const task = await prisma.task.findFirst({
    where: {
      projectId: project.id,
      deletedAt: null,
      ...(token.kind === "TASK"
        ? { id: token.id }
        : {
            currentPlanVersion: {
              nodes: {
                some: { nodeId: token.id, node: { deletedAt: null } },
              },
            },
          }),
    },
    select: {
      id: true,
      createdAt: true,
      currentPlanVersion: {
        select: {
          plannedStartAt: true,
          nodes: {
            where: token.kind === "NODE" ? { nodeId: token.id } : { nodeId: { in: [] } },
            take: 1,
            select: {
              node: {
                select: {
                  id: true,
                  milestone: { select: { expectedCompletedAt: true } },
                  revision: { select: { revisionAt: true } },
                  termination: { select: { plannedAt: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!task) return null;
  const node = task.currentPlanVersion.nodes[0]?.node;
  if (token.kind === "NODE" && !node) return null;
  const centerAt = token.kind === "TASK"
    ? (task.currentPlanVersion.plannedStartAt ?? task.createdAt)
    : (
        node?.milestone?.expectedCompletedAt ??
        node?.revision?.revisionAt ??
        node?.termination?.plannedAt
      );
  if (!centerAt) return null;

  return {
    focusId: token.kind === "TASK"
      ? `project-start:${task.id}`
      : `project-node:${token.id}`,
    centerMs: centerAt.getTime(),
  };
}

export function actorCanReviewProjects(actor: ProjectManagementActor) { return isSystemAdministrator(actor); }

function parseProjectTimelineFocus(focus: string) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuidPattern.test(focus)) return { kind: "NODE" as const, id: focus };
  const [prefix, id, extra] = focus.split(":");
  if (extra || !id || !uuidPattern.test(id)) return null;
  if (prefix === "project-start") return { kind: "TASK" as const, id };
  if (prefix === "project-node") return { kind: "NODE" as const, id };
  return null;
}

async function loadProjectDetailTaskRows(
  projectId: string,
): Promise<ProjectDetailTaskRow[]> {
  const rows = await prisma.task.findMany({
    where: { projectId, deletedAt: null },
    select: projectDetailTaskSelect,
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  return projectTaskStatusGroups.flatMap((statusGroup) =>
    rows.filter((row) =>
      statusGroup.some((status) => status === row.status),
    ),
  );
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
