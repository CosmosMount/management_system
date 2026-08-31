import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  authorize,
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
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import {
  createProjectInputSchema,
  resubmitProjectInputSchema,
  reviewProjectEstablishmentInputSchema,
  type ProjectMemberInput,
} from "@/lib/project-management/validations/project";
import {
  assertProjectState,
  assertProjectVersion,
  loadLockedProjectTx,
  lockCrossAggregateTx,
  lockIdempotencyTx,
  lockTasksTx,
  projectResource,
  taskResource,
  type PrismaTx,
  type ProjectForMutation,
  type ProjectMutationResult,
} from "@/lib/project-management/application/project-command-context";
import {
  assertPeopleActiveTx,
  claimProjectAvatarTx,
  replaceProjectMembersTx,
  withProjectAvatarFailureCleanup,
} from "@/lib/project-management/application/project-edit-support";
import {
  recordTaskProjectChangeTx,
  syncProjectMembersFromTasksTx,
} from "@/lib/project-management/application/project-task-membership";

export async function createProject(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<ProjectMutationResult> {
  const parsed = createProjectInputSchema.parse(input);
  const requestHash = hashRequest(parsed);
  return withProjectAvatarFailureCleanup(parsed.avatarPath, actor.openId, () => prisma.$transaction(async (tx) => {
    await lockGlobalApprovalAdministratorSetTx(tx);
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
    await lockGlobalApprovalAdministratorSetTx(tx);
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
    await lockGlobalApprovalAdministratorSetTx(tx);
    await lockCrossAggregateTx(tx);
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

async function loadActorForAccountTx(tx: PrismaTx, accountId: string): Promise<ProjectManagementActor> {
  await tx.$queryRaw`
    SELECT person."id"
    FROM "Person" AS person
    WHERE person."accountId" = ${accountId}
    FOR UPDATE
  `;
  const account = await tx.account.findUnique({ where: { id: accountId }, select: { person: { select: { id: true, status: true } }, identities: { where: { provider: "FEISHU", tenantId: "default" }, select: { openId: true, unionId: true }, take: 1 }, systemRoles: { where: { revokedAt: null }, select: { role: true, team: true, techGroup: true } } } });
  if (!account?.person) throw stateConflictError("本轮提交人账号已不可用，请驳回后重新提交");
  const isActive = account.person.status === "ACTIVE";
  return { accountId, personId: account.person.id, openId: account.identities[0]?.openId ?? "", unionId: account.identities[0]?.unionId, isActive, systemRoles: isActive ? account.systemRoles : [] };
}

function hashRequest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function projectSnapshot(input: { name: string; description: string; avatarPath?: string | null; members: ProjectMemberInput[]; requestedTaskIds: string[] }): Prisma.InputJsonValue { return { name: input.name, description: input.description, avatarPath: input.avatarPath ?? null, members: input.members, requestedTaskIds: input.requestedTaskIds }; }
function auditSnapshot(input: { name: string; description: string; members: ProjectMemberInput[] }, taskCount: number, round: number): Prisma.InputJsonValue { return { name: input.name, descriptionHash: createHash("sha256").update(input.description).digest("hex"), ownerCount: input.members.filter((member) => member.role === "OWNER").length, participantCount: input.members.filter((member) => member.role === "PARTICIPANT").length, taskCount, round, status: "PENDING_APPROVAL" }; }

async function notifyEstablishmentSubmittedTx(tx: PrismaTx, actor: ProjectManagementActor, project: { id: string; name: string }, requestId: string, round: number) {
  await lockGlobalApprovalAdministratorSetTx(tx);
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
async function projectNotificationDetailsTx(tx: PrismaTx, projectId: string, requestId: string) {
  const [owners, taskCount] = await Promise.all([
    tx.projectMember.findMany({ where: { projectId, role: "OWNER", removedAt: null }, select: { person: { select: { displayName: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    tx.projectEstablishmentRequestedTask.count({ where: { requestId } }),
  ]);
  return { ownerNames: owners.map((owner) => owner.person.displayName), taskCount };
}
