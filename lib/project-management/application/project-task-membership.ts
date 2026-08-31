import type {
  Prisma,
  ProjectMemberRole,
  TaskMemberRole,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertAuthorized } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForPersonIdsTx,
} from "@/lib/project-management/application/notification-utils";
import {
  notFoundError,
  staleTaskError,
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import { updateTaskProjectInputSchema } from "@/lib/project-management/validations/project";
import {
  lockCrossAggregateTx,
  lockTasksTx,
  taskResource,
  type PrismaTx,
} from "@/lib/project-management/application/project-command-context";

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
export async function syncProjectMembersFromTasksTx(tx: PrismaTx, projectId: string, tasks: Array<{ id: string; members: Array<{ personId: string; role: TaskMemberRole; removedAt: Date | null }> }>, actor: ProjectManagementActor) {
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
export async function recordTaskProjectChangeTx(tx: PrismaTx, actor: ProjectManagementActor, task: { id: string; title: string; status: Prisma.TaskGetPayload<object>["status"]; members: Array<{ personId: string; role: TaskMemberRole; removedAt: Date | null }>; beforeProjectId: string | null; afterProjectId: string | null; lockVersion: number }) {
  await createDomainAuditEventTx(tx, { actorAccountId: actor.accountId, actorPersonId: actor.personId, action: task.afterProjectId ? (task.beforeProjectId ? "pm.task.project.move" : "pm.task.project.assign") : "pm.task.project.remove", entityType: "Task", entityId: task.id, taskId: task.id, projectId: task.afterProjectId ?? task.beforeProjectId, before: { projectId: task.beforeProjectId }, after: { projectId: task.afterProjectId, lockVersion: task.lockVersion } });
  const projectIds = [task.beforeProjectId, task.afterProjectId].filter((id): id is string => Boolean(id));
  const projects = projectIds.length ? await tx.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true, members: { where: { removedAt: null, role: "OWNER" }, select: { personId: true } } } }) : [];
  const recipientPersonIds = [...new Set([...task.members.filter((member) => !member.removedAt && (member.role === "OWNER" || member.role === "PARTICIPANT")).map((member) => member.personId), ...projects.flatMap((project) => project.members.map((member) => member.personId))])];
  const recipients = await recipientsForPersonIdsTx(tx, recipientPersonIds);
  const primaryProject = projects.find((project) => project.id === task.afterProjectId) ?? projects[0];
  await createProjectManagementEventNotificationsTx(tx, { actor, task: { id: task.id, title: task.title, status: task.status }, project: primaryProject ? { id: primaryProject.id, name: primaryProject.name } : null, kind: "project_task_changed", category: "PROJECT", eventKey: `pm:task:${task.id}:project:${task.lockVersion}`, title: "任务所属项目已变更", summary: task.afterProjectId ? `任务「${task.title}」已${task.beforeProjectId ? "移动到" : "加入"}项目「${primaryProject?.name ?? "未命名项目"}」` : `任务「${task.title}」已移出项目`, entityType: "Task", entityId: task.id, linkPath: `/progress/tasks/${task.id}`, mandatory: false, recipients, context: { beforeProjectId: task.beforeProjectId, afterProjectId: task.afterProjectId, taskStatus: task.status } });
}
