import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type {
  AuthorizationProjectResource,
  AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import {
  notFoundError,
  stateConflictError,
} from "@/lib/project-management/application/errors";

export type PrismaTx = Prisma.TransactionClient;
const CROSS_AGGREGATE_LOCK = 2_026_080_619;

const projectMutationInclude = {
  members: { where: { removedAt: null }, orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] },
  establishmentRequests: {
    where: { status: "PENDING" as const },
    include: { requestedTasks: { orderBy: { sortOrder: "asc" as const } } },
    take: 1,
  },
} satisfies Prisma.ProjectInclude;

export type ProjectForMutation = Prisma.ProjectGetPayload<{ include: typeof projectMutationInclude }>;

export type ProjectMutationResult = {
  projectId: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "ACTIVE" | "COMPLETED";
  lockVersion: number;
  requestId?: string;
  created?: boolean;
};

export async function loadLockedProjectTx(tx: PrismaTx, projectId: string): Promise<ProjectForMutation> {
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} AND "deletedAt" IS NULL FOR UPDATE`;
  const project = await tx.project.findFirst({ where: { id: projectId, deletedAt: null }, include: projectMutationInclude });
  if (!project) throw notFoundError();
  return project;
}

export async function acquireProjectCrossAggregateLockTx(tx: PrismaTx) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CROSS_AGGREGATE_LOCK})`; }
export async function lockCrossAggregateTx(tx: PrismaTx) { await acquireProjectCrossAggregateLockTx(tx); }
export async function lockTasksTx(tx: PrismaTx, taskIds: string[]) {
  for (const id of [...new Set(taskIds)].sort()) await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${id} FOR UPDATE`;
}
export async function lockIdempotencyTx(tx: PrismaTx, accountId: string, key: string) {
  const lockKey = BigInt(`0x${createHash("sha256").update(`${accountId}:${key}`).digest("hex").slice(0, 15)}`);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
}

export function taskResource(task: { id: string; team: string; techGroup: string; status: Prisma.TaskGetPayload<object>["status"]; priority: Prisma.TaskGetPayload<object>["priority"]; createdByAccountId: string; members: Array<{ personId: string; role: Prisma.TaskMemberGetPayload<object>["role"]; removedAt: Date | null }> }): AuthorizationTaskResource {
  return { type: "task", id: task.id, team: task.team, techGroup: task.techGroup, status: task.status, priority: task.priority, createdByAccountId: task.createdByAccountId, members: task.members };
}
export function projectResource(project: ProjectForMutation): AuthorizationProjectResource { return { type: "project", id: project.id, status: project.status, requesterAccountId: project.requesterAccountId, members: project.members }; }
export function assertProjectState(project: ProjectForMutation, status: ProjectForMutation["status"]) { if (project.status !== status) throw stateConflictError(`当前 Project 状态为 ${project.status}，不能执行此操作`); }
export function assertProjectVersion(project: ProjectForMutation, expected: number) { if (project.lockVersion !== expected) throw stateConflictError("Project 已被他人修改，请刷新后重试"); }
