import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { assertAuthorized } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForAccountIdsTx,
  recipientsForPersonIdsTx,
} from "@/lib/project-management/application/notification-utils";
import { stateConflictError } from "@/lib/project-management/application/errors";
import { isProjectCompletionBlockingTaskStatus } from "@/lib/project-management/domain/project-lifecycle";
import {
  projectLifecycleInputSchema,
  updateProjectInputSchema,
  type ProjectMemberInput,
} from "@/lib/project-management/validations/project";
import {
  assertProjectState,
  assertProjectVersion,
  loadLockedProjectTx,
  lockCrossAggregateTx,
  lockTasksTx,
  projectResource,
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
import { recordTaskProjectChangeTx } from "@/lib/project-management/application/project-task-membership";

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
    await replaceProjectMembersTx(tx, project, refreshedActor, parsed.members, parsed.name, { notifyAdditions: false });
    const updated = await tx.project.update({ where: { id: project.id }, data: { name: parsed.name, description: parsed.description, avatarPath: parsed.avatarPath, lockVersion: { increment: 1 } } });
    if (metadataChanged) await createDomainAuditEventTx(tx, { actorAccountId: refreshedActor.accountId, actorPersonId: refreshedActor.personId, action: "pm.project.metadata.update", entityType: "Project", entityId: project.id, projectId: project.id, before: { name: project.name, descriptionHash: createHash("sha256").update(project.description).digest("hex") }, after: { name: parsed.name, descriptionHash: createHash("sha256").update(parsed.description).digest("hex"), lockVersion: updated.lockVersion } });
    if (avatarChanged) await createDomainAuditEventTx(tx, { actorAccountId: refreshedActor.accountId, actorPersonId: refreshedActor.personId, action: "pm.project.avatar.update", entityType: "Project", entityId: project.id, projectId: project.id, before: { avatarPath: project.avatarPath }, after: { avatarPath: parsed.avatarPath, lockVersion: updated.lockVersion } });
    if (membersChanged) {
      const beforeMembers = project.members.map((member) => ({ personId: member.personId, role: member.role }));
      await createDomainAuditEventTx(tx, { actorAccountId: refreshedActor.accountId, actorPersonId: refreshedActor.personId, action: "pm.project.members.update", entityType: "Project", entityId: project.id, projectId: project.id, before: { members: beforeMembers }, after: { members: parsed.members, lockVersion: updated.lockVersion } });
    }
    await notifyProjectUpdatedTx(
      tx,
      refreshedActor,
      project,
      updated,
      parsed.members,
      membersChanged,
    );
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
    const blocking = tasks.filter((task) =>
      isProjectCompletionBlockingTaskStatus(task.status),
    );
    if (blocking.length) throw stateConflictError(`仍有 ${blocking.length} 个 Task 处于草稿或进行中：${blocking.slice(0, 5).map((task) => task.title).join("、")}`);
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

function sameMembers(current: ProjectForMutation["members"], requested: ProjectMemberInput[]) { return current.length === requested.length && current.every((member) => requested.some((item) => item.personId === member.personId && item.role === member.role)); }

async function notifyProjectUpdatedTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  beforeProject: ProjectForMutation,
  afterProject: Pick<
    ProjectForMutation,
    "id" | "name" | "description" | "avatarPath" | "status" | "lockVersion"
  >,
  afterMembers: ProjectMemberInput[],
  membersChanged: boolean,
) {
  const publicChangedFields = [
    beforeProject.name !== afterProject.name ? "项目名称" : null,
    beforeProject.description !== afterProject.description ? "项目内容" : null,
    beforeProject.avatarPath !== afterProject.avatarPath ? "项目头像" : null,
    membersChanged ? "项目成员" : null,
  ].filter((field): field is string => Boolean(field));

  const recipients = [
    ...(await recipientsForAccountIdsTx(tx, [
      beforeProject.requesterAccountId,
      actor.accountId,
    ])),
    ...(await recipientsForPersonIdsTx(tx, [
      ...beforeProject.members.map((member) => member.personId),
      ...afterMembers.map((member) => member.personId),
    ])),
  ];
  await createProjectManagementEventNotificationsTx(tx, {
    actor,
    project: { id: afterProject.id, name: afterProject.name },
    kind: "project_updated",
    category: "PROJECT",
    eventKey: `pm:project:${afterProject.id}:updated:${afterProject.lockVersion}`,
    title: "项目信息已更新",
    summary: `项目「${afterProject.name}」的信息已更新：${publicChangedFields.join("、")}`,
    entityType: "Project",
    entityId: afterProject.id,
    linkPath: `/progress/projects/${afterProject.id}`,
    mandatory: false,
    recipients,
    context: {
      changedFields: publicChangedFields,
      afterStatus: afterProject.status,
    },
  });
}

async function notifyLifecycleTx(tx: PrismaTx, actor: ProjectManagementActor, project: ProjectForMutation, kind: "project_completed" | "project_deleted", title: string, summary: string, version: number, taskCount: number) {
  const recipients = [...await recipientsForAccountIdsTx(tx, [project.requesterAccountId]), ...await recipientsForPersonIdsTx(tx, project.members.map((member) => member.personId))];
  const owners = await tx.projectMember.findMany({ where: { projectId: project.id, role: "OWNER", removedAt: null }, select: { person: { select: { displayName: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  await createProjectManagementEventNotificationsTx(tx, { actor, project: { id: project.id, name: project.name }, kind, category: "PROJECT", eventKey: `pm:project:${project.id}:${kind}:${version}`, title, summary: `${summary}；负责人：${owners.map((owner) => owner.person.displayName).join("、") || "未设置"}；关联 ${taskCount} 个任务`, entityType: "Project", entityId: project.id, linkPath: `/progress/projects/${project.id}`, mandatory: false, recipients, context: { lockVersion: version, beforeStatus: project.status, afterStatus: kind === "project_completed" ? "COMPLETED" : "DELETED", ownerNames: owners.map((owner) => owner.person.displayName), taskCount } });
}
