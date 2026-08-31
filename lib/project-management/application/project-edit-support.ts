import { prisma } from "@/lib/prisma";
import { isSystemAdministrator } from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForPersonIdsTx,
} from "@/lib/project-management/application/notification-utils";
import {
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import type { ProjectMemberInput } from "@/lib/project-management/validations/project";
import type {
  PrismaTx,
  ProjectForMutation,
} from "@/lib/project-management/application/project-command-context";

export async function assertPeopleActiveTx(tx: PrismaTx, requestedIds: string[], existingIds: string[]) {
  const newIds = [...new Set(requestedIds)].filter((id) => !existingIds.includes(id));
  if (!newIds.length) return;
  const count = await tx.person.count({ where: { id: { in: newIds }, status: "ACTIVE" } });
  if (count !== newIds.length) throw validationError("成员不存在或已停用", { members: ["只能新增有效人员"] });
}
export async function claimProjectAvatarTx(tx: PrismaTx, projectId: string, avatarPath: string | null | undefined, ownerOpenId: string) {
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
export async function withProjectAvatarFailureCleanup<T>(avatarPath: string | null | undefined, ownerOpenId: string, operation: () => Promise<T>): Promise<T> {
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
export async function replaceProjectMembersTx(tx: PrismaTx, project: ProjectForMutation, actor: ProjectManagementActor, requested: ProjectMemberInput[], targetProjectName: string, options: { notifyAdditions?: boolean } = {}) {
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
    if (options.notifyAdditions !== false) {
      for (const member of additions) {
        const recipients = await recipientsForPersonIdsTx(tx, [member.personId]);
        await createProjectManagementEventNotificationsTx(tx, { actor, project: { id: project.id, name: targetProjectName }, kind: "project_member_added", category: "PROJECT", eventKey: `pm:project:${project.id}:member:${member.personId}:${member.role}:${project.lockVersion + 1}`, title: "你已被加入项目", summary: `你已作为${member.role === "OWNER" ? "负责人" : "参与人"}加入项目「${targetProjectName}」`, entityType: "ProjectMember", entityId: member.personId, linkPath: `/progress/projects/${project.id}`, mandatory: false, recipients, context: { role: member.role } });
      }
    }
  }
}
