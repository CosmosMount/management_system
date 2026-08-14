import { createHash, randomUUID } from "node:crypto";
import type { Prisma, ProjectMemberRole, TaskMemberRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  authorize,
  isSystemAdministrator,
  type AuthorizationProjectResource,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import {
  activeGlobalApprovalAdministratorAccountIdsTx,
  lockGlobalApprovalAdministratorSetTx,
  USABLE_GLOBAL_APPROVAL_ADMINISTRATOR_REQUIRED,
} from "@/lib/project-management/approval-administrators";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForAccountIdsTx,
  recipientsForPersonIdsTx,
} from "@/lib/project-management/application/notification-utils";
import {
  notFoundError,
  staleTaskError,
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import {
  createProjectInputSchema,
  projectLifecycleInputSchema,
  resubmitProjectInputSchema,
  reviewProjectEstablishmentInputSchema,
  updateProjectInputSchema,
  updateTaskProjectInputSchema,
  type ProjectMemberInput,
} from "@/lib/project-management/validations/project";

type PrismaTx = Prisma.TransactionClient;
const CROSS_AGGREGATE_LOCK = 2_026_080_619;

const projectMutationInclude = {
  members: { where: { removedAt: null }, orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] },
  establishmentRequests: {
    where: { status: "PENDING" as const },
    include: { requestedTasks: { orderBy: { sortOrder: "asc" as const } } },
    take: 1,
  },
} satisfies Prisma.ProjectInclude;

type ProjectForMutation = Prisma.ProjectGetPayload<{ include: typeof projectMutationInclude }>;

export type ProjectMutationResult = {
  projectId: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "ACTIVE" | "COMPLETED";
  lockVersion: number;
  requestId?: string;
  created?: boolean;
};

export async function createProject(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<ProjectMutationResult> {
  const parsed = createProjectInputSchema.parse(input);
  const requestHash = hashRequest(parsed);
  return withProjectAvatarFailureCleanup(parsed.avatarPath, actor.openId, () => prisma.$transaction(async (tx) => {
    await lockCrossAggregateTx(tx);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    assertAuthorized({ actor: refreshedActor, action: "project.create", resource: { type: "project" } });
    await lockIdempotencyTx(tx, refreshedActor.accountId, parsed.idempotencyKey);
    const existing = await tx.projectEstablishmentRequest.findUnique({
      where: { submittedByAccountId_idempotencyKey: { submittedByAccountId: refreshedActor.accountId, idempotencyKey: parsed.idempotencyKey } },
      select: { id: true, requestHash: true, project: { select: { id: true, status: true, lockVersion: true } } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) throw stateConflictError("相同请求键已用于不同内容，请刷新后重试");
      return { projectId: existing.project.id, status: existing.project.status, lockVersion: existing.project.lockVersion, requestId: existing.id, created: false };
    }
    await assertPeopleActiveTx(tx, parsed.members.map((member) => member.personId), []);
    const tasks = await loadAndValidateRequestedTasksTx(tx, refreshedActor, parsed.requestedTaskIds);
    const projectId = randomUUID();
    const requestId = randomUUID();
    const snapshot = projectSnapshot(parsed);
    await tx.project.create({
      data: {
        id: projectId,
        name: parsed.name,
        description: parsed.description,
        avatarPath: parsed.avatarPath,
        requesterAccountId: refreshedActor.accountId,
        status: "PENDING_APPROVAL",
        members: { create: parsed.members.map((member) => ({ personId: member.personId, role: member.role, createdByAccountId: refreshedActor.accountId })) },
        establishmentRequests: {
          create: {
            id: requestId,
            round: 1,
            status: "PENDING",
            idempotencyKey: parsed.idempotencyKey,
            requestHash,
            submittedByAccountId: refreshedActor.accountId,
            snapshot,
            requestedTasks: { create: tasks.map((task, index) => ({ taskId: task.id, lockVersion: task.lockVersion, sortOrder: index })) },
          },
        },
      },
    });
    await claimProjectAvatarTx(tx, projectId, parsed.avatarPath, refreshedActor.openId);
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.project.establishment.submit",
      entityType: "Project",
      entityId: projectId,
      projectId,
      after: auditSnapshot(parsed, tasks.length, 1),
    });
    await notifyEstablishmentSubmittedTx(tx, refreshedActor, { id: projectId, name: parsed.name }, requestId, 1);
    return { projectId, status: "PENDING_APPROVAL", lockVersion: 0, requestId, created: true };
  }));
}

export async function resubmitProject(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<ProjectMutationResult> {
  const parsed = resubmitProjectInputSchema.parse(input);
  const requestHash = hashRequest(parsed);
  return withProjectAvatarFailureCleanup(parsed.avatarPath, actor.openId, () => prisma.$transaction(async (tx) => {
    await lockCrossAggregateTx(tx);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const project = await loadLockedProjectTx(tx, parsed.projectId);
    await lockIdempotencyTx(tx, refreshedActor.accountId, parsed.idempotencyKey);
    const existing = await tx.projectEstablishmentRequest.findUnique({
      where: { submittedByAccountId_idempotencyKey: { submittedByAccountId: refreshedActor.accountId, idempotencyKey: parsed.idempotencyKey } },
      select: { id: true, projectId: true, requestHash: true, round: true },
    });
    if (existing) {
      if (existing.projectId !== project.id || existing.requestHash !== requestHash) throw stateConflictError("相同请求键已用于不同内容，请刷新后重试");
      return { projectId: project.id, status: project.status, lockVersion: project.lockVersion, requestId: existing.id };
    }
    assertAuthorized({ actor: refreshedActor, action: "project.submit_establishment", resource: projectResource(project) });
    assertProjectState(project, "DRAFT");
    assertProjectVersion(project, parsed.expectedLockVersion);
    await assertPeopleActiveTx(tx, parsed.members.map((member) => member.personId), project.members.map((member) => member.personId));
    const tasks = await loadAndValidateRequestedTasksTx(tx, refreshedActor, parsed.requestedTaskIds);
    await claimProjectAvatarTx(tx, project.id, parsed.avatarPath, refreshedActor.openId);
    await replaceProjectMembersTx(tx, project, refreshedActor, parsed.members, parsed.name);
    const round = project.establishmentRound + 1;
    const request = await tx.projectEstablishmentRequest.create({
      data: {
        projectId: project.id,
        round,
        idempotencyKey: parsed.idempotencyKey,
        requestHash,
        submittedByAccountId: refreshedActor.accountId,
        snapshot: projectSnapshot(parsed),
        requestedTasks: { create: tasks.map((task, index) => ({ taskId: task.id, lockVersion: task.lockVersion, sortOrder: index })) },
      },
    });
    const updated = await tx.project.update({
      where: { id: project.id },
      data: {
        name: parsed.name,
        description: parsed.description,
        avatarPath: parsed.avatarPath,
        status: "PENDING_APPROVAL",
        establishmentRound: round,
        submittedAt: new Date(),
        reviewedAt: null,
        reviewedByAccountId: null,
        reviewComment: "",
        lockVersion: { increment: 1 },
      },
    });
    await createDomainAuditEventTx(tx, { actorAccountId: refreshedActor.accountId, actorPersonId: refreshedActor.personId, action: "pm.project.establishment.resubmit", entityType: "Project", entityId: project.id, projectId: project.id, before: { status: project.status, round: project.establishmentRound }, after: auditSnapshot(parsed, tasks.length, round) });
    await notifyEstablishmentSubmittedTx(tx, refreshedActor, { id: project.id, name: parsed.name }, request.id, round);
    return { projectId: project.id, status: updated.status, lockVersion: updated.lockVersion, requestId: request.id };
  }));
}

export async function reviewProjectEstablishment(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<ProjectMutationResult> {
  const parsed = reviewProjectEstablishmentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockCrossAggregateTx(tx);
    await lockGlobalApprovalAdministratorSetTx(tx);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const project = await loadLockedProjectTx(tx, parsed.projectId);
    assertAuthorized({ actor: refreshedActor, action: "project.review_establishment", resource: projectResource(project) });
    const persistedRequest = await tx.projectEstablishmentRequest.findFirst({ where: { id: parsed.requestId, projectId: project.id }, select: { id: true, status: true } });
    if (!persistedRequest) throw stateConflictError("立项申请不存在或不属于当前 Project");
    if (persistedRequest.status !== "PENDING") {
      const expectedStatus = parsed.decision === "APPROVE" ? "APPROVED" : "REJECTED";
      if (persistedRequest.status !== expectedStatus) throw stateConflictError("立项申请已按其他决定处理");
      return { projectId: project.id, status: project.status, lockVersion: project.lockVersion, requestId: persistedRequest.id };
    }
    assertProjectState(project, "PENDING_APPROVAL");
    assertProjectVersion(project, parsed.expectedLockVersion);
    const request = project.establishmentRequests[0];
    if (!request || request.id !== parsed.requestId || request.status !== "PENDING") throw stateConflictError("立项申请已处理，请刷新后重试");
    const now = new Date();
    if (parsed.decision === "REJECT") {
      await tx.projectEstablishmentRequest.update({ where: { id: request.id }, data: { status: "REJECTED", reviewerAccountId: refreshedActor.accountId, reviewComment: parsed.comment, reviewedAt: now } });
      const updated = await tx.project.update({ where: { id: project.id }, data: { status: "DRAFT", reviewedAt: now, reviewedByAccountId: refreshedActor.accountId, reviewComment: parsed.comment, lockVersion: { increment: 1 } } });
      await createDomainAuditEventTx(tx, { actorAccountId: refreshedActor.accountId, actorPersonId: refreshedActor.personId, action: "pm.project.establishment.reject", entityType: "Project", entityId: project.id, projectId: project.id, before: { status: project.status }, after: { status: updated.status, round: request.round, comment: parsed.comment } });
      await notifyEstablishmentResultTx(tx, refreshedActor, project, request, false, parsed.comment);
      return { projectId: project.id, status: updated.status, lockVersion: updated.lockVersion, requestId: request.id };
    }
    const submitter = await loadActorForAccountTx(tx, request.submittedByAccountId);
    const requestedTaskIds = request.requestedTasks.map((entry) => entry.taskId).sort();
    await lockTasksTx(tx, requestedTaskIds);
    const tasks = await tx.task.findMany({ where: { id: { in: requestedTaskIds } }, include: { members: { where: { removedAt: null } } }, orderBy: { id: "asc" } });
    const requestedVersions = new Map(request.requestedTasks.map((entry) => [entry.taskId, entry.lockVersion]));
    const conflicts = tasks.filter((task) => task.deletedAt || task.projectId || task.lockVersion !== requestedVersions.get(task.id) || !authorize({ actor: submitter, action: "task.update_metadata", resource: taskResource(task) }).allowed);
    if (tasks.length !== requestedTaskIds.length || conflicts.length) {
      const names = conflicts.slice(0, 5).map((task) => task.title).join("、");
      throw stateConflictError(`有 ${Math.max(conflicts.length, requestedTaskIds.length - tasks.length)} 个 Task 已不可加入${names ? `：${names}` : ""}`);
    }
    await tx.projectEstablishmentRequest.update({ where: { id: request.id }, data: { status: "APPROVED", reviewerAccountId: refreshedActor.accountId, reviewComment: parsed.comment, reviewedAt: now } });
    if (tasks.length) {
      await tx.task.updateMany({ where: { id: { in: tasks.map((task) => task.id) }, projectId: null, deletedAt: null }, data: { projectId: project.id, lockVersion: { increment: 1 } } });
      await syncProjectMembersFromTasksTx(tx, project.id, tasks, refreshedActor);
    }
    const updated = await tx.project.update({ where: { id: project.id }, data: { status: "ACTIVE", startedAt: now, reviewedAt: now, reviewedByAccountId: refreshedActor.accountId, reviewComment: parsed.comment, lockVersion: { increment: 1 } } });
    await createDomainAuditEventTx(tx, { actorAccountId: refreshedActor.accountId, actorPersonId: refreshedActor.personId, action: "pm.project.establishment.approve", entityType: "Project", entityId: project.id, projectId: project.id, before: { status: project.status }, after: { status: updated.status, round: request.round, taskCount: tasks.length } });
    for (const task of tasks) await recordTaskProjectChangeTx(tx, refreshedActor, { id: task.id, title: task.title, status: task.status, members: task.members, beforeProjectId: null, afterProjectId: project.id, lockVersion: task.lockVersion + 1 });
    await notifyEstablishmentResultTx(tx, refreshedActor, project, request, true, parsed.comment);
    return { projectId: project.id, status: updated.status, lockVersion: updated.lockVersion, requestId: request.id };
  });
}

export async function updateProject(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<ProjectMutationResult> {
  const parsed = updateProjectInputSchema.parse(input);
  return withProjectAvatarFailureCleanup(parsed.avatarPath, actor.openId, () => prisma.$transaction(async (tx) => {
    await lockCrossAggregateTx(tx);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const project = await loadLockedProjectTx(tx, parsed.projectId);
    assertAuthorized({ actor: refreshedActor, action: "project.update", resource: projectResource(project) });
    assertProjectState(project, "ACTIVE");
    assertProjectVersion(project, parsed.expectedLockVersion);
    await assertPeopleActiveTx(tx, parsed.members.map((member) => member.personId), project.members.map((member) => member.personId));
    const metadataChanged = project.name !== parsed.name || project.description !== parsed.description;
    const avatarChanged = project.avatarPath !== parsed.avatarPath;
    const membersChanged = !sameMembers(project.members, parsed.members);
    const changed = metadataChanged || avatarChanged || membersChanged;
    if (!changed) return { projectId: project.id, status: project.status, lockVersion: project.lockVersion };
    await claimProjectAvatarTx(tx, project.id, parsed.avatarPath, refreshedActor.openId);
    await replaceProjectMembersTx(tx, project, refreshedActor, parsed.members, parsed.name);
    const updated = await tx.project.update({ where: { id: project.id }, data: { name: parsed.name, description: parsed.description, avatarPath: parsed.avatarPath, lockVersion: { increment: 1 } } });
    if (metadataChanged) await createDomainAuditEventTx(tx, { actorAccountId: refreshedActor.accountId, actorPersonId: refreshedActor.personId, action: "pm.project.metadata.update", entityType: "Project", entityId: project.id, projectId: project.id, before: { name: project.name, descriptionHash: createHash("sha256").update(project.description).digest("hex") }, after: { name: parsed.name, descriptionHash: createHash("sha256").update(parsed.description).digest("hex"), lockVersion: updated.lockVersion } });
    if (avatarChanged) await createDomainAuditEventTx(tx, { actorAccountId: refreshedActor.accountId, actorPersonId: refreshedActor.personId, action: "pm.project.avatar.update", entityType: "Project", entityId: project.id, projectId: project.id, before: { avatarPath: project.avatarPath }, after: { avatarPath: parsed.avatarPath, lockVersion: updated.lockVersion } });
    if (membersChanged) {
      const beforeMembers = project.members.map((member) => ({ personId: member.personId, role: member.role }));
      await createDomainAuditEventTx(tx, { actorAccountId: refreshedActor.accountId, actorPersonId: refreshedActor.personId, action: "pm.project.members.update", entityType: "Project", entityId: project.id, projectId: project.id, before: { members: beforeMembers }, after: { members: parsed.members, lockVersion: updated.lockVersion } });
    }
    return { projectId: project.id, status: updated.status, lockVersion: updated.lockVersion };
  }));
}

export async function completeProject(actor: ProjectManagementActor, input: unknown): Promise<ProjectMutationResult> {
  const parsed = projectLifecycleInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockCrossAggregateTx(tx);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const project = await loadLockedProjectTx(tx, parsed.projectId);
    assertAuthorized({ actor: refreshedActor, action: "project.complete", resource: projectResource(project) });
    assertProjectState(project, "ACTIVE");
    assertProjectVersion(project, parsed.expectedLockVersion);
    const pendingRequestCount = await tx.projectEstablishmentRequest.count({ where: { projectId: project.id, status: "PENDING" } });
    if (pendingRequestCount > 0) throw stateConflictError("Project 仍有待审批立项申请，不能结束");
    const tasks = await tx.task.findMany({ where: { projectId: project.id, deletedAt: null }, select: { id: true, title: true, status: true }, orderBy: { id: "asc" } });
    const blocking = tasks.filter((task) => task.status !== "COMPLETED");
    if (blocking.length) throw stateConflictError(`仍有 ${blocking.length} 个 Task 未完成：${blocking.slice(0, 5).map((task) => task.title).join("、")}`);
    const updated = await tx.project.update({ where: { id: project.id }, data: { status: "COMPLETED", completedAt: new Date(), lockVersion: { increment: 1 } } });
    await createDomainAuditEventTx(tx, { actorAccountId: refreshedActor.accountId, actorPersonId: refreshedActor.personId, action: "pm.project.complete", entityType: "Project", entityId: project.id, projectId: project.id, before: { status: project.status }, after: { status: updated.status, taskCount: tasks.length } });
    await notifyLifecycleTx(tx, refreshedActor, project, "project_completed", "项目已结束", `项目「${project.name}」已结束`, updated.lockVersion, tasks.length);
    return { projectId: project.id, status: updated.status, lockVersion: updated.lockVersion };
  });
}

export async function deleteProject(actor: ProjectManagementActor, input: unknown): Promise<ProjectMutationResult> {
  const parsed = projectLifecycleInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockCrossAggregateTx(tx);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const project = await loadLockedProjectTx(tx, parsed.projectId);
    assertAuthorized({ actor: refreshedActor, action: "project.delete", resource: projectResource(project) });
    if (project.status === "COMPLETED") throw stateConflictError("已结束的 Project 不能删除");
    assertProjectVersion(project, parsed.expectedLockVersion);
    const projectTasks = await tx.task.findMany({ where: { projectId: project.id }, select: { id: true, title: true, status: true, lockVersion: true, members: { where: { removedAt: null }, select: { personId: true, role: true, removedAt: true } } }, orderBy: { id: "asc" } });
    const taskIds = projectTasks.map((task) => task.id);
    await lockTasksTx(tx, taskIds);
    await tx.task.updateMany({ where: { id: { in: taskIds }, projectId: project.id }, data: { projectId: null, lockVersion: { increment: 1 } } });
    await tx.projectEstablishmentRequest.updateMany({ where: { projectId: project.id, status: "PENDING" }, data: { status: "CANCELLED", reviewerAccountId: refreshedActor.accountId, reviewedAt: new Date(), reviewComment: "Project 已删除" } });
    const pendingApprovalOutboxes = await tx.notificationOutbox.findMany({ where: { eventKey: { startsWith: `pm:project:${project.id}:establishment:` }, status: { in: ["PENDING", "PROCESSING", "FAILED"] } }, select: { id: true } });
    const pendingApprovalOutboxIds = pendingApprovalOutboxes.map((outbox) => outbox.id);
    if (pendingApprovalOutboxIds.length) {
      await tx.notificationOutbox.updateMany({ where: { id: { in: pendingApprovalOutboxIds } }, data: { status: "CANCELED", lockedUntil: null, lastError: "Project 已删除" } });
      await tx.notificationOutboxRecipient.updateMany({ where: { outboxId: { in: pendingApprovalOutboxIds }, status: { in: ["PENDING", "PROCESSING", "FAILED"] } }, data: { status: "CANCELED", lockedUntil: null, lastError: "Project 已删除" } });
    }
    await tx.fileAsset.updateMany({ where: { projectId: project.id, kind: "PROJECT_AVATAR" }, data: { cleanupRequestedAt: new Date(), cleanupNextRunAt: new Date(), cleanupLastError: "Project 已删除，等待清理" } });
    const updated = await tx.project.update({ where: { id: project.id }, data: { deletedAt: new Date(), deletedByAccountId: refreshedActor.accountId, lockVersion: { increment: 1 } } });
    for (const task of projectTasks) await recordTaskProjectChangeTx(tx, refreshedActor, { id: task.id, title: task.title, status: task.status, members: task.members, beforeProjectId: project.id, afterProjectId: null, lockVersion: task.lockVersion + 1 });
    await createDomainAuditEventTx(tx, { actorAccountId: refreshedActor.accountId, actorPersonId: refreshedActor.personId, action: "pm.project.delete", entityType: "Project", entityId: project.id, projectId: project.id, before: { status: project.status, taskCount: taskIds.length }, after: { deleted: true } });
    await notifyLifecycleTx(tx, refreshedActor, project, "project_deleted", "项目已删除", `项目「${project.name}」已删除，关联任务已保留并移出项目`, updated.lockVersion, taskIds.length);
    return { projectId: project.id, status: updated.status, lockVersion: updated.lockVersion };
  });
}

export async function updateTaskProject(actor: ProjectManagementActor, input: unknown) {
  const parsed = updateTaskProjectInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockCrossAggregateTx(tx);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    await lockTasksTx(tx, [parsed.taskId]);
    const task = await tx.task.findFirst({ where: { id: parsed.taskId, deletedAt: null }, include: { members: { where: { removedAt: null } } } });
    if (!task) throw notFoundError();
    assertAuthorized({ actor: refreshedActor, action: "task.update_metadata", resource: taskResource(task) });
    if (task.lockVersion !== parsed.expectedLockVersion) throw staleTaskError(task);
    if (task.projectId === parsed.projectId) return { taskId: task.id, projectId: task.projectId, lockVersion: task.lockVersion };
    await assertTaskProjectChangeAllowedTx(tx, task.projectId, parsed.projectId);
    const previousProjectId = task.projectId;
    const updated = await tx.task.update({ where: { id: task.id }, data: { projectId: parsed.projectId, lockVersion: { increment: 1 } } });
    if (parsed.projectId) await syncTaskMembersToProjectTx(tx, { projectId: parsed.projectId, taskId: task.id, members: task.members, actor: refreshedActor });
    await recordTaskProjectChangeTx(tx, refreshedActor, { id: task.id, title: task.title, status: task.status, members: task.members, beforeProjectId: previousProjectId, afterProjectId: parsed.projectId, lockVersion: updated.lockVersion });
    return { taskId: task.id, projectId: updated.projectId, lockVersion: updated.lockVersion };
  });
}

async function loadLockedProjectTx(tx: PrismaTx, projectId: string): Promise<ProjectForMutation> {
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} AND "deletedAt" IS NULL FOR UPDATE`;
  const project = await tx.project.findFirst({ where: { id: projectId, deletedAt: null }, include: projectMutationInclude });
  if (!project) throw notFoundError();
  return project;
}

export async function acquireProjectCrossAggregateLockTx(tx: PrismaTx) { await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CROSS_AGGREGATE_LOCK})`; }
async function lockCrossAggregateTx(tx: PrismaTx) { await acquireProjectCrossAggregateLockTx(tx); }
async function lockTasksTx(tx: PrismaTx, taskIds: string[]) {
  for (const id of [...new Set(taskIds)].sort()) await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${id} FOR UPDATE`;
}
async function lockIdempotencyTx(tx: PrismaTx, accountId: string, key: string) {
  const lockKey = BigInt(`0x${createHash("sha256").update(`${accountId}:${key}`).digest("hex").slice(0, 15)}`);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
}

async function loadAndValidateRequestedTasksTx(tx: PrismaTx, actor: ProjectManagementActor, taskIds: string[]) {
  await lockCrossAggregateTx(tx);
  await lockTasksTx(tx, taskIds);
  const tasks = await tx.task.findMany({ where: { id: { in: taskIds } }, include: { members: { where: { removedAt: null } } }, orderBy: { id: "asc" } });
  if (tasks.length !== taskIds.length || tasks.some((task) => task.deletedAt || task.projectId || !authorize({ actor, action: "task.update_metadata", resource: taskResource(task) }).allowed)) {
    throw validationError("存在不可加入的 Task，请刷新后重试", { requestedTaskIds: ["Task 已归属其他 Project、已删除或你没有修改权限"] });
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return taskIds.map((id) => byId.get(id)!);
}

async function assertPeopleActiveTx(tx: PrismaTx, requestedIds: string[], existingIds: string[]) {
  const newIds = [...new Set(requestedIds)].filter((id) => !existingIds.includes(id));
  if (!newIds.length) return;
  const count = await tx.person.count({ where: { id: { in: newIds }, status: "ACTIVE" } });
  if (count !== newIds.length) throw validationError("成员不存在或已停用", { members: ["只能新增有效人员"] });
}

async function claimProjectAvatarTx(tx: PrismaTx, projectId: string, avatarPath: string | null | undefined, ownerOpenId: string) {
  const current = await tx.fileAsset.findFirst({ where: { projectId }, select: { id: true, publicPath: true } });
  if (!avatarPath) {
    if (current) await tx.fileAsset.update({ where: { id: current.id }, data: { projectId: null, cleanupRequestedAt: new Date(), cleanupNextRunAt: new Date(), cleanupLastError: "Project 头像已恢复默认，等待清理" } });
    return;
  }
  await tx.$queryRaw`SELECT "id" FROM "FileAsset" WHERE "publicPath" = ${avatarPath} FOR UPDATE`;
  const asset = await tx.fileAsset.findUnique({ where: { publicPath: avatarPath }, select: { id: true, kind: true, ownerOpenId: true, projectId: true, mimeType: true, size: true } });
  if (!asset || asset.kind !== "PROJECT_AVATAR" || (!asset.projectId && asset.ownerOpenId !== ownerOpenId) || (asset.projectId && asset.projectId !== projectId) || !["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType) || asset.size > 2 * 1024 * 1024) {
    throw validationError("Project 头像无效或不属于当前账号", { avatarPath: ["请重新上传头像"] });
  }
  if (current && current.id !== asset.id) await tx.fileAsset.update({ where: { id: current.id }, data: { projectId: null, cleanupRequestedAt: new Date(), cleanupNextRunAt: new Date(), cleanupLastError: "Project 头像已替换，等待清理" } });
  await tx.fileAsset.update({ where: { id: asset.id }, data: { projectId, cleanupRequestedAt: null, cleanupNextRunAt: null, cleanupAttempts: 0, cleanupLastError: "" } });
}

async function withProjectAvatarFailureCleanup<T>(avatarPath: string | null | undefined, ownerOpenId: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (avatarPath) {
      await prisma.fileAsset.updateMany({
        where: { publicPath: avatarPath, kind: "PROJECT_AVATAR", ownerOpenId, projectId: null },
        data: { cleanupRequestedAt: new Date(), cleanupNextRunAt: new Date(), cleanupLastError: "Project 保存失败，等待清理" },
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function replaceProjectMembersTx(tx: PrismaTx, project: ProjectForMutation, actor: ProjectManagementActor, requested: ProjectMemberInput[], targetProjectName: string) {
  const requestedById = new Map(requested.map((member) => [member.personId, member.role]));
  const currentById = new Map(project.members.map((member) => [member.personId, member]));
  const removingIds = project.members.filter((member) => !requestedById.has(member.personId)).map((member) => member.personId);
  if (!isSystemAdministrator(actor) && currentById.get(actor.personId)?.role === "OWNER" && requestedById.get(actor.personId) !== "OWNER") {
    throw stateConflictError("负责人不能移除或降级自己，请由其他负责人操作");
  }
  if (removingIds.length) {
    const blockers = await tx.task.findMany({ where: { projectId: project.id, deletedAt: null, members: { some: { personId: { in: removingIds }, role: { in: ["OWNER", "PARTICIPANT"] }, removedAt: null } } }, select: { title: true }, take: 5 });
    if (blockers.length) throw stateConflictError(`成员仍参与关联 Task，不能移除：${blockers.map((task) => task.title).join("、")}`);
  }
  const changedCurrent = project.members.filter((member) => requestedById.get(member.personId) !== member.role);
  if (changedCurrent.length) await tx.projectMember.updateMany({ where: { id: { in: changedCurrent.map((member) => member.id) } }, data: { removedAt: new Date(), removedByAccountId: actor.accountId } });
  const removed = project.members.filter((member) => !requestedById.has(member.personId));
  if (removed.length) await tx.projectMember.updateMany({ where: { id: { in: removed.map((member) => member.id) } }, data: { removedAt: new Date(), removedByAccountId: actor.accountId } });
  const additions = requested.filter((member) => currentById.get(member.personId)?.role !== member.role);
  if (additions.length) {
    await tx.projectMember.createMany({ data: additions.map((member) => ({ projectId: project.id, personId: member.personId, role: member.role, createdByAccountId: actor.accountId })) });
    for (const member of additions) {
      const recipients = await recipientsForPersonIdsTx(tx, [member.personId]);
      await createProjectManagementEventNotificationsTx(tx, { actor, project: { id: project.id, name: targetProjectName }, kind: "project_member_added", category: "PROJECT", eventKey: `pm:project:${project.id}:member:${member.personId}:${member.role}:${project.lockVersion + 1}`, title: "你已被加入项目", summary: `你已作为${member.role === "OWNER" ? "负责人" : "参与人"}加入项目「${targetProjectName}」`, entityType: "ProjectMember", entityId: member.personId, linkPath: `/progress/projects/${project.id}`, mandatory: false, recipients, context: { role: member.role } });
    }
  }
}

async function syncProjectMembersFromTasksTx(tx: PrismaTx, projectId: string, tasks: Array<{ id: string; members: Array<{ personId: string; role: TaskMemberRole; removedAt: Date | null }> }>, actor: ProjectManagementActor) {
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} AND "deletedAt" IS NULL FOR UPDATE`;
  const personIds = [...new Set(tasks.flatMap((task) => task.members.filter((member) => !member.removedAt && (member.role === "OWNER" || member.role === "PARTICIPANT")).map((member) => member.personId)))];
  if (!personIds.length) return 0;
  const existing = await tx.projectMember.findMany({ where: { projectId, personId: { in: personIds }, removedAt: null }, select: { personId: true } });
  const existingIds = new Set(existing.map((member) => member.personId));
  const missing = personIds.filter((id) => !existingIds.has(id));
  if (!missing.length) return 0;
  const participantCount = await tx.projectMember.count({ where: { projectId, role: "PARTICIPANT", removedAt: null } });
  if (participantCount + missing.length > 50) {
    throw validationError("Task 成员加入后会超过 Project 参与人员上限", { members: [`Project 参与人员最多 50 人，当前还可新增 ${Math.max(50 - participantCount, 0)} 人`] });
  }
  await tx.projectMember.createMany({ data: missing.map((personId) => ({ projectId, personId, role: "PARTICIPANT" as ProjectMemberRole, createdByAccountId: actor.accountId })) });
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, lockVersion: true } });
  for (const personId of missing) {
    const sourceTaskIds = tasks.filter((task) => task.members.some((member) => member.personId === personId && !member.removedAt && (member.role === "OWNER" || member.role === "PARTICIPANT"))).map((task) => task.id).slice(0, 20);
    await createDomainAuditEventTx(tx, { actorAccountId: actor.accountId, actorPersonId: actor.personId, action: "pm.project.member.auto_add", entityType: "ProjectMember", entityId: `${projectId}:${personId}`, projectId, after: { personId, role: "PARTICIPANT", sourceTaskIds } });
    const recipients = await recipientsForPersonIdsTx(tx, [personId]);
    await createProjectManagementEventNotificationsTx(tx, { actor, project: { id: projectId, name: project.name }, kind: "project_member_added", category: "PROJECT", eventKey: `pm:project:${projectId}:member:auto:${personId}:${sourceTaskIds.join(":")}:${project.lockVersion}`, title: "你已被加入项目", summary: `由于你参与关联任务，已自动加入项目「${project.name}」`, entityType: "ProjectMember", entityId: personId, linkPath: `/progress/projects/${projectId}`, mandatory: false, recipients, context: { role: "PARTICIPANT", sourceTaskIds } });
  }
  return missing.length;
}

export async function assertActiveProjectTargetTx(tx: PrismaTx, projectId: string | null | undefined) {
  if (!projectId) return null;
  const project = await tx.project.findFirst({ where: { id: projectId, status: "ACTIVE", deletedAt: null }, select: { id: true, name: true } });
  if (!project) throw validationError("只能选择进行中的 Project", { projectId: ["只能选择进行中的 Project"] });
  return project;
}

export async function assertTaskProjectChangeAllowedTx(tx: PrismaTx, currentProjectId: string | null | undefined, targetProjectId: string | null | undefined) {
  if (currentProjectId === targetProjectId) return;
  if (currentProjectId) {
    const current = await tx.project.findFirst({ where: { id: currentProjectId, deletedAt: null }, select: { status: true } });
    if (current?.status === "COMPLETED") throw stateConflictError("已结束 Project 的 Task 归属只读，不能移动或移出");
  }
  await assertActiveProjectTargetTx(tx, targetProjectId);
}

export async function syncTaskMembersToProjectTx(tx: PrismaTx, input: { projectId: string | null | undefined; taskId: string; members: Array<{ personId: string; role: TaskMemberRole; removedAt?: Date | null }>; actor: ProjectManagementActor }) {
  if (!input.projectId) return;
  const addedCount = await syncProjectMembersFromTasksTx(tx, input.projectId, [{ id: input.taskId, members: input.members.map((member) => ({ personId: member.personId, role: member.role, removedAt: member.removedAt ?? null })) }], input.actor);
  if (addedCount > 0) await tx.project.update({ where: { id: input.projectId }, data: { lockVersion: { increment: 1 } } });
}

async function loadActorForAccountTx(tx: PrismaTx, accountId: string): Promise<ProjectManagementActor> {
  const account = await tx.account.findUnique({ where: { id: accountId }, select: { person: { select: { id: true } }, identities: { where: { provider: "FEISHU", tenantId: "default" }, select: { openId: true, unionId: true }, take: 1 }, systemRoles: { where: { revokedAt: null }, select: { role: true, team: true, techGroup: true } } } });
  if (!account?.person) throw stateConflictError("本轮提交人账号已不可用，请驳回后重新提交");
  return { accountId, personId: account.person.id, openId: account.identities[0]?.openId ?? "", unionId: account.identities[0]?.unionId, systemRoles: account.systemRoles };
}

function taskResource(task: { id: string; team: string; techGroup: string; status: Prisma.TaskGetPayload<object>["status"]; priority: Prisma.TaskGetPayload<object>["priority"]; members: Array<{ personId: string; role: Prisma.TaskMemberGetPayload<object>["role"]; removedAt: Date | null }> }): AuthorizationTaskResource {
  return { type: "task", id: task.id, team: task.team, techGroup: task.techGroup, status: task.status, priority: task.priority, members: task.members };
}
function projectResource(project: ProjectForMutation): AuthorizationProjectResource { return { type: "project", id: project.id, status: project.status, requesterAccountId: project.requesterAccountId, members: project.members }; }
function assertProjectState(project: ProjectForMutation, status: ProjectForMutation["status"]) { if (project.status !== status) throw stateConflictError(`当前 Project 状态为 ${project.status}，不能执行此操作`); }
function assertProjectVersion(project: ProjectForMutation, expected: number) { if (project.lockVersion !== expected) throw stateConflictError("Project 已被他人修改，请刷新后重试"); }
function sameMembers(current: ProjectForMutation["members"], requested: ProjectMemberInput[]) { return current.length === requested.length && current.every((member) => requested.some((item) => item.personId === member.personId && item.role === member.role)); }
function hashRequest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function projectSnapshot(input: { name: string; description: string; avatarPath?: string | null; members: ProjectMemberInput[]; requestedTaskIds: string[] }): Prisma.InputJsonValue { return { name: input.name, description: input.description, avatarPath: input.avatarPath ?? null, members: input.members, requestedTaskIds: input.requestedTaskIds }; }
function auditSnapshot(input: { name: string; description: string; members: ProjectMemberInput[] }, taskCount: number, round: number): Prisma.InputJsonValue { return { name: input.name, descriptionHash: createHash("sha256").update(input.description).digest("hex"), ownerCount: input.members.filter((member) => member.role === "OWNER").length, participantCount: input.members.filter((member) => member.role === "PARTICIPANT").length, taskCount, round, status: "PENDING_APPROVAL" }; }

async function notifyEstablishmentSubmittedTx(tx: PrismaTx, actor: ProjectManagementActor, project: { id: string; name: string }, requestId: string, round: number) {
  const accountIds = await activeGlobalApprovalAdministratorAccountIdsTx(tx, { requireFeishuOpenId: true });
  if (!accountIds.length) throw stateConflictError(USABLE_GLOBAL_APPROVAL_ADMINISTRATOR_REQUIRED);
  const recipients = await recipientsForAccountIdsTx(tx, accountIds);
  const details = await projectNotificationDetailsTx(tx, project.id, requestId);
  await createProjectManagementEventNotificationsTx(tx, { actor, project, kind: "project_establishment_submitted", category: "PROJECT", eventKey: `pm:project:${project.id}:establishment:${round}:submitted`, title: "项目立项待审批", summary: `项目「${project.name}」第 ${round} 轮立项申请等待审批；负责人：${details.ownerNames.join("、") || "未设置"}；申请纳入 ${details.taskCount} 个任务`, entityType: "ProjectEstablishmentRequest", entityId: requestId, linkPath: `/progress/projects/${project.id}#establishment`, mandatory: true, recipients, context: { round, beforeStatus: round === 1 ? null : "DRAFT", afterStatus: "PENDING_APPROVAL", ownerNames: details.ownerNames, taskCount: details.taskCount } });
}
async function notifyEstablishmentResultTx(tx: PrismaTx, actor: ProjectManagementActor, project: ProjectForMutation, request: ProjectForMutation["establishmentRequests"][number], approved: boolean, comment: string) {
  const accountIds = [project.requesterAccountId, request.submittedByAccountId];
  const currentMembers = await tx.projectMember.findMany({ where: { projectId: project.id, removedAt: null }, select: { personId: true, role: true, person: { select: { displayName: true } } } });
  const peopleIds = currentMembers.map((member) => member.personId);
  const recipients = [...await recipientsForAccountIdsTx(tx, accountIds), ...await recipientsForPersonIdsTx(tx, peopleIds)];
  const ownerNames = currentMembers.filter((member) => member.role === "OWNER").map((member) => member.person.displayName);
  await createProjectManagementEventNotificationsTx(tx, { actor, project: { id: project.id, name: project.name }, kind: "project_establishment_result", category: "PROJECT", eventKey: `pm:project:${project.id}:establishment:${request.round}:${approved ? "approved" : "rejected"}`, title: approved ? "项目立项已通过" : "项目立项已驳回", summary: `项目「${project.name}」：${approved ? "已进入进行中状态" : `未通过，审批意见：${comment}`}；负责人：${ownerNames.join("、") || "未设置"}；本轮涉及 ${request.requestedTasks.length} 个任务`, entityType: "ProjectEstablishmentRequest", entityId: request.id, linkPath: `/progress/projects/${project.id}`, mandatory: false, recipients, context: { round: request.round, decision: approved ? "APPROVED" : "REJECTED", beforeStatus: "PENDING_APPROVAL", afterStatus: approved ? "ACTIVE" : "DRAFT", ownerNames, taskCount: request.requestedTasks.length, comment } });
}
async function notifyLifecycleTx(tx: PrismaTx, actor: ProjectManagementActor, project: ProjectForMutation, kind: "project_completed" | "project_deleted", title: string, summary: string, version: number, taskCount: number) {
  const recipients = [...await recipientsForAccountIdsTx(tx, [project.requesterAccountId]), ...await recipientsForPersonIdsTx(tx, project.members.map((member) => member.personId))];
  const owners = await tx.projectMember.findMany({ where: { projectId: project.id, role: "OWNER", removedAt: null }, select: { person: { select: { displayName: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  await createProjectManagementEventNotificationsTx(tx, { actor, project: { id: project.id, name: project.name }, kind, category: "PROJECT", eventKey: `pm:project:${project.id}:${kind}:${version}`, title, summary: `${summary}；负责人：${owners.map((owner) => owner.person.displayName).join("、") || "未设置"}；关联 ${taskCount} 个任务`, entityType: "Project", entityId: project.id, linkPath: `/progress/projects/${project.id}`, mandatory: false, recipients, context: { lockVersion: version, beforeStatus: project.status, afterStatus: kind === "project_completed" ? "COMPLETED" : "DELETED", ownerNames: owners.map((owner) => owner.person.displayName), taskCount } });
}

export async function recordTaskProjectChangeTx(tx: PrismaTx, actor: ProjectManagementActor, task: { id: string; title: string; status: Prisma.TaskGetPayload<object>["status"]; members: Array<{ personId: string; role: TaskMemberRole; removedAt: Date | null }>; beforeProjectId: string | null; afterProjectId: string | null; lockVersion: number }) {
  await createDomainAuditEventTx(tx, { actorAccountId: actor.accountId, actorPersonId: actor.personId, action: task.afterProjectId ? (task.beforeProjectId ? "pm.task.project.move" : "pm.task.project.assign") : "pm.task.project.remove", entityType: "Task", entityId: task.id, taskId: task.id, projectId: task.afterProjectId ?? task.beforeProjectId, before: { projectId: task.beforeProjectId }, after: { projectId: task.afterProjectId, lockVersion: task.lockVersion } });
  const projectIds = [task.beforeProjectId, task.afterProjectId].filter((id): id is string => Boolean(id));
  const projects = projectIds.length ? await tx.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true, members: { where: { removedAt: null, role: "OWNER" }, select: { personId: true } } } }) : [];
  const recipientPersonIds = [...new Set([...task.members.filter((member) => !member.removedAt && (member.role === "OWNER" || member.role === "PARTICIPANT")).map((member) => member.personId), ...projects.flatMap((project) => project.members.map((member) => member.personId))])];
  const recipients = await recipientsForPersonIdsTx(tx, recipientPersonIds);
  const primaryProject = projects.find((project) => project.id === task.afterProjectId) ?? projects[0];
  await createProjectManagementEventNotificationsTx(tx, { actor, task: { id: task.id, title: task.title, status: task.status }, project: primaryProject ? { id: primaryProject.id, name: primaryProject.name } : null, kind: "project_task_changed", category: "PROJECT", eventKey: `pm:task:${task.id}:project:${task.lockVersion}`, title: "任务所属项目已变更", summary: task.afterProjectId ? `任务「${task.title}」已${task.beforeProjectId ? "移动到" : "加入"}项目「${primaryProject?.name ?? "未命名项目"}」` : `任务「${task.title}」已移出项目`, entityType: "Task", entityId: task.id, linkPath: `/progress/tasks/${task.id}`, mandatory: false, recipients, context: { beforeProjectId: task.beforeProjectId, afterProjectId: task.afterProjectId, taskStatus: task.status } });
}

async function projectNotificationDetailsTx(tx: PrismaTx, projectId: string, requestId: string) {
  const [owners, taskCount] = await Promise.all([
    tx.projectMember.findMany({ where: { projectId, role: "OWNER", removedAt: null }, select: { person: { select: { displayName: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    tx.projectEstablishmentRequestedTask.count({ where: { requestId } }),
  ]);
  return { ownerNames: owners.map((owner) => owner.person.displayName), taskCount };
}
