import { prisma } from "@/lib/prisma";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { stateConflictError } from "@/lib/project-management/application/errors";
import { assertTaskVisible, loadTaskForAuthorizationTx, lockTaskTx } from "@/lib/project-management/application/lifecycle-domain";
import { createProjectManagementEventNotificationsTx, recipientsForAccountIdsTx, recipientsForPersonIdsTx, uniqueRecipientsByAccount } from "@/lib/project-management/application/notification-utils";
import { activeGlobalApprovalAdministratorAccountIdsTx } from "@/lib/project-management/approval-administrators";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { TASK_URGE_COOLDOWN_MS, TASK_URGE_DEFAULT_MESSAGE, urgeTaskInputSchema } from "@/lib/project-management/validations/task-urge";

export async function urgeTask(actor: ProjectManagementActor, input: unknown) {
  const parsed = urgeTaskInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockTaskTx(tx, parsed.taskId);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, parsed.taskId);
    assertTaskVisible(refreshedActor, task);
    const previous = await tx.domainAuditEvent.findFirst({
      where: { taskId: task.id, action: "pm.task.urge", actorAccountId: actor.accountId, requestId: parsed.requestId },
    });
    if (previous) {
      if (previous.reason !== parsed.message) throw stateConflictError("该请求已提交，请重新打开弹窗发起新的催促");
      return urgeResult(task.id, previous);
    }
    if (task.status !== "ACTIVE") throw stateConflictError("仅进行中的任务可以催促");
    const latest = await tx.domainAuditEvent.findFirst({
      where: { taskId: task.id, action: "pm.task.urge" },
      orderBy: { createdAt: "desc" },
    });
    const now = new Date();
    if (latest && latest.createdAt.getTime() + TASK_URGE_COOLDOWN_MS > now.getTime()) {
      const seconds = Math.ceil((latest.createdAt.getTime() + TASK_URGE_COOLDOWN_MS - now.getTime()) / 1000);
      throw stateConflictError(`该任务刚刚已被催促，请在 ${seconds} 秒后重试`);
    }
    const detail = await tx.task.findUniqueOrThrow({
      where: { id: task.id },
      select: { project: { select: { id: true, name: true, deletedAt: true } } },
    });
    const project = detail.project && !detail.project.deletedAt ? { id: detail.project.id, name: detail.project.name } : null;
    const people = await tx.person.findMany({
      where: { id: { in: task.members.filter((member) => member.role === "OWNER").map((member) => member.personId) }, status: "ACTIVE" },
      select: { displayName: true },
      orderBy: { id: "asc" },
    });
    const recipients = uniqueRecipientsByAccount([
      ...await recipientsForPersonIdsTx(tx, task.members.map((member) => member.personId)),
      ...await recipientsForAccountIdsTx(tx, [actor.accountId, ...await activeGlobalApprovalAdministratorAccountIdsTx(tx)]),
    ]);
    const audit = await createDomainAuditEventTx(tx, {
      actorAccountId: actor.accountId,
      actorPersonId: actor.personId,
      action: "pm.task.urge",
      entityType: "Task",
      entityId: task.id,
      taskId: task.id,
      projectId: project?.id ?? null,
      requestId: parsed.requestId,
      reason: parsed.message,
      after: { taskTitle: task.title, taskStatus: task.status, projectName: project?.name ?? null, recipientAccountIds: recipients.map((recipient) => recipient.accountId) },
    });
    await createProjectManagementEventNotificationsTx(tx, {
      actor: refreshedActor,
      task,
      project,
      kind: "task_urged",
      category: "TASK",
      eventKey: `pm:task:urge:${audit.id}`,
      title: "任务催促提醒",
      summary: parsed.message || TASK_URGE_DEFAULT_MESSAGE,
      entityType: "Task",
      entityId: task.id,
      mandatory: true,
      recipients,
      context: { urgedAt: audit.createdAt.toISOString(), ownerNames: people.map((person) => person.displayName) },
    });
    return urgeResult(task.id, audit);
  });
}

function urgeResult(taskId: string, audit: { id: string; createdAt: Date }) {
  return { taskId, urgeId: audit.id, nextAllowedAt: new Date(audit.createdAt.getTime() + TASK_URGE_COOLDOWN_MS).toISOString() };
}
