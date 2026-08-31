import type { Prisma } from "@prisma/client";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForAccountIdsTx,
  recipientsForPersonIdsTx,
} from "@/lib/project-management/application/notification-utils";
import { jsonValue } from "@/lib/project-management/application/prisma-json";
import type { TaskForMutation } from "@/lib/project-management/application/task-mutation-records";

type PrismaTx = Prisma.TransactionClient;

export function metadataSnapshot(task: TaskForMutation) {
  return {
    title: task.title,
    description: task.description,
    team: task.team,
    techGroup: task.techGroup,
    priority: task.priority,
    relatedTaskId: task.relatedTaskId,
    projectId: task.projectId,
    lockVersion: task.lockVersion,
  };
}

export async function auditTaskProjectChangeTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  beforeTask: TaskForMutation,
  afterTask: TaskForMutation,
) {
  if (beforeTask.projectId === afterTask.projectId) return;
  await createDomainAuditEventTx(tx, {
    actorAccountId: actor.accountId,
    actorPersonId: actor.personId,
    action: afterTask.projectId
      ? beforeTask.projectId
        ? "pm.task.project.move"
        : "pm.task.project.assign"
      : "pm.task.project.remove",
    entityType: "Task",
    entityId: afterTask.id,
    taskId: afterTask.id,
    projectId: afterTask.projectId ?? beforeTask.projectId,
    before: jsonValue({ projectId: beforeTask.projectId }),
    after: jsonValue({ projectId: afterTask.projectId }),
    reason: "更新 Task 所属 Project",
  });
  const projectIds = [beforeTask.projectId, afterTask.projectId].filter(
    (id): id is string => Boolean(id)
  );
  const projects = projectIds.length
    ? await tx.project.findMany({
        where: { id: { in: projectIds } },
        select: {
          id: true,
          name: true,
          members: {
            where: { removedAt: null, role: "OWNER" },
            select: { personId: true }
          }
        }
      })
    : [];
  const recipientPersonIds = [
    ...new Set([
      ...afterTask.members
        .filter(
          (member) =>
            member.role === "OWNER" || member.role === "PARTICIPANT"
        )
        .map((member) => member.personId),
      ...projects.flatMap((project) =>
        project.members.map((member) => member.personId)
      )
    ])
  ];
  const recipients = await recipientsForPersonIdsTx(tx, recipientPersonIds);
  const primaryProject =
    projects.find((project) => project.id === afterTask.projectId) ?? projects[0];
  await createProjectManagementEventNotificationsTx(tx, {
    actor,
    task: { id: afterTask.id, title: afterTask.title, status: afterTask.status },
    project: primaryProject
      ? { id: primaryProject.id, name: primaryProject.name }
      : null,
    kind: "project_task_changed",
    category: "PROJECT",
    eventKey: `pm:task:${afterTask.id}:project:${afterTask.lockVersion}`,
    title: "任务所属项目已变更",
    summary: afterTask.projectId
      ? `任务「${afterTask.title}」已${beforeTask.projectId ? "移动到" : "加入"}项目「${primaryProject?.name ?? "未命名项目"}」`
      : `任务「${afterTask.title}」已移出项目`,
    entityType: "Task",
    entityId: afterTask.id,
    linkPath: `/progress/tasks/${afterTask.id}`,
    mandatory: false,
    recipients,
    context: {
      beforeProjectId: beforeTask.projectId,
      afterProjectId: afterTask.projectId
    },
  });
}

export async function notifyTaskUpdatedTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  beforeTask: TaskForMutation,
  afterTask: TaskForMutation,
) {
  const changedFields = taskBasicInformationChangedFields(beforeTask, afterTask);
  if (changedFields.length === 0) return;

  const memberPersonIds = [
    ...beforeTask.members,
    ...afterTask.members,
  ]
    .filter(
      (member) => member.role === "OWNER" || member.role === "PARTICIPANT",
    )
    .map((member) => member.personId);
  const recipients = [
    ...(await recipientsForAccountIdsTx(tx, [actor.accountId])),
    ...(await recipientsForPersonIdsTx(tx, memberPersonIds)),
  ];
  await createProjectManagementEventNotificationsTx(tx, {
    actor,
    task: {
      id: afterTask.id,
      title: afterTask.title,
      status: afterTask.status,
      currentPlanVersionId: afterTask.currentPlanVersionId,
    },
    kind: "task_updated",
    category: "TASK",
    eventKey: `pm:task:${afterTask.id}:updated:${afterTask.lockVersion}`,
    title: "任务信息已更新",
    summary: `任务「${afterTask.title}」的信息已更新：${changedFields.join("、")}`,
    entityType: "Task",
    entityId: afterTask.id,
    linkPath: `/progress/tasks/${afterTask.id}`,
    mandatory: false,
    recipients,
    context: { changedFields },
  });
}

function taskBasicInformationChangedFields(
  beforeTask: TaskForMutation,
  afterTask: TaskForMutation,
) {
  return [
    beforeTask.title !== afterTask.title ? "任务名称" : null,
    beforeTask.description !== afterTask.description ? "任务内容" : null,
    beforeTask.team !== afterTask.team ? "车组" : null,
    beforeTask.techGroup !== afterTask.techGroup ? "技术组" : null,
    beforeTask.priority !== afterTask.priority ? "优先级" : null,
    beforeTask.relatedTaskId !== afterTask.relatedTaskId ? "关联任务" : null,
  ].filter((field): field is string => Boolean(field));
}
