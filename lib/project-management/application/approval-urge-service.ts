import { prisma } from "@/lib/prisma";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { stateConflictError } from "@/lib/project-management/application/errors";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { activeGlobalApprovalAdministratorAccountIdsTx } from "@/lib/project-management/approval-administrators";
import { createProjectManagementEventNotificationsTx, recipientsForAccountIdsTx } from "@/lib/project-management/application/notification-utils";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { approvalUrgeInputSchema } from "@/lib/project-management/validations/approval-urge";

export async function urgeApproval(actor: ProjectManagementActor, input: unknown) {
  const parsed = approvalUrgeInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const administrators = await activeGlobalApprovalAdministratorAccountIdsTx(tx);
    let taskId: string | null = null;
    let title = "待审批事项";
    let submitterAccountId: string | null = null;
    const entityType = parsed.kind;
    let projectId: string | null = null;
    if (parsed.kind === "MILESTONE_REVIEW") {
      const review = await tx.milestoneReview.findFirst({ where: { id: parsed.approvalId, result: "PENDING", revokedAt: null }, select: { id: true, submittedByAccountId: true, milestoneNode: { select: { goal: true, node: { select: { taskId: true, task: { select: { projectId: true } } } } } } } });
      if (!review) throw stateConflictError("该审批已处理或不存在，请刷新后重试");
      taskId = review.milestoneNode.node.taskId; title = review.milestoneNode.goal; submitterAccountId = review.submittedByAccountId; projectId = review.milestoneNode.node.task.projectId;
    } else if (parsed.kind === "REVISION") {
      const revision = await tx.revisionNode.findFirst({ where: { id: parsed.approvalId, status: "PENDING_APPROVAL" }, select: { id: true, targetPlanVersion: { select: { createdByAccountId: true } }, reason: true, node: { select: { taskId: true, task: { select: { projectId: true } } } } } });
      if (!revision) throw stateConflictError("该审批已处理或不存在，请刷新后重试");
      taskId = revision.node.taskId; title = revision.reason || "计划修订"; submitterAccountId = revision.targetPlanVersion?.createdByAccountId ?? null; projectId = revision.node.task.projectId;
    } else {
      const review = await tx.terminationReview.findFirst({ where: { id: parsed.approvalId, result: "PENDING" }, select: { id: true, submittedByAccountId: true, terminationNode: { select: { name: true, node: { select: { taskId: true, task: { select: { projectId: true } } } } } } } });
      if (!review) throw stateConflictError("该审批已处理或不存在，请刷新后重试");
      taskId = review.terminationNode.node.taskId; title = review.terminationNode.name; submitterAccountId = review.submittedByAccountId; projectId = review.terminationNode.node.task.projectId;
    }
    const allowedToUrge = actor.accountId === submitterAccountId || administrators.includes(actor.accountId);
    if (!allowedToUrge) throw stateConflictError("你无权催促该审批");
    const validIds = new Set(administrators);
    const selectedIds = [...new Set(parsed.recipientAccountIds)].filter((id) => validIds.has(id));
    if (selectedIds.length === 0) throw stateConflictError("所选审批人已无效，请刷新后重试");
    const previous = await tx.domainAuditEvent.findFirst({ where: { action: "pm.approval.urge", entityId: parsed.approvalId, requestId: parsed.requestId } });
    if (previous) return { approvalId: parsed.approvalId };
    const task = taskId ? await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { id: true, title: true, status: true, currentPlanVersionId: true, project: { select: { id: true, name: true } } } }) : null;
    const recipients = await recipientsForAccountIdsTx(tx, selectedIds);
    const audit = await createDomainAuditEventTx(tx, { actorAccountId: actor.accountId, actorPersonId: actor.personId, action: "pm.approval.urge", entityType, entityId: parsed.approvalId, taskId, projectId, requestId: parsed.requestId, reason: `recipients:${selectedIds.join(",")}`, after: { kind: parsed.kind, title, recipientAccountIds: recipients.map((recipient) => recipient.accountId) } });
    await createProjectManagementEventNotificationsTx(tx, { actor: refreshedActor, task, project: task?.project ?? null, kind: "approval_urged", category: "REVIEW", eventKey: `pm:approval:urge:${audit.id}`, title: "审批催促提醒", summary: `任务「${task?.title ?? "项目任务"}」的${title}仍待审批，请及时处理。`, entityType, entityId: parsed.approvalId, mandatory: true, recipients, context: { approvalKind: parsed.kind, approvalTitle: title, urgedAt: audit.createdAt.toISOString() } });
    return { approvalId: parsed.approvalId };
  });
}

export async function loadApprovalUrgeTargets() {
  const ids = await activeGlobalApprovalAdministratorAccountIdsTx(prisma);
  const accounts = await prisma.account.findMany({
    where: { id: { in: ids }, person: { is: { status: "ACTIVE" } } },
    select: { id: true, person: { select: { displayName: true } } },
    orderBy: { id: "asc" },
  });
  return accounts.map((account) => ({ accountId: account.id, displayName: account.person?.displayName ?? "审批管理员" }));
}
