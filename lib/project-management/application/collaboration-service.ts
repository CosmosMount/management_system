import type { Prisma, ProjectStatus, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  type AuthorizationProjectResource,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import {
  notFoundError,
  stateConflictError,
} from "@/lib/project-management/application/errors";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForAccountIdsTx,
  recipientsForPersonIdsTx,
  uniqueRecipientsByAccount,
} from "@/lib/project-management/application/notification-utils";
import { activeGlobalApprovalAdministratorAccountIdsTx } from "@/lib/project-management/approval-administrators";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  createCommentInputSchema,
  createRiskInputSchema,
  deleteCommentInputSchema,
  resolveRiskInputSchema,
} from "@/lib/project-management/validations/collaboration";

type PrismaTx = Prisma.TransactionClient;
type TargetType = "PROJECT" | "TASK";

type TargetContext =
  | {
      type: "PROJECT";
      id: string;
      name: string;
      status: ProjectStatus;
      members: Array<{ personId: string; role: "OWNER" | "PARTICIPANT"; removedAt: Date | null }>;
    }
  | {
      type: "TASK";
      id: string;
      title: string;
      status: TaskStatus;
      projectId: string | null;
      project: { id: string; name: string } | null;
      team: string;
      techGroup: string;
      priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
      members: Array<{
        personId: string;
        role: "OWNER" | "PARTICIPANT";
        removedAt: Date | null;
      }>;
    };

export async function createRisk(
  actor: ProjectManagementActor,
  input: unknown,
) {
  const parsed = createRiskInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const target = await loadLockedTargetTx(tx, parsed.targetType, parsed.targetId);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    assertRiskPermission(refreshedActor, target, "create");
    if (target.status !== "ACTIVE") {
      throw stateConflictError("只有进行中的对象可以提出风险");
    }
    const actorName = await actorNameTx(tx, refreshedActor);
    const risk = await tx.riskRecord.create({
      data: {
        ...targetForeignKey(target),
        content: parsed.content,
        createdByAccountId: refreshedActor.accountId,
        createdByPersonId: refreshedActor.personId,
        createdByName: actorName,
      },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: target.type === "PROJECT" ? "pm.project.risk.create" : "pm.task.risk.create",
      entityType: "RiskRecord",
      entityId: risk.id,
      taskId: target.type === "TASK" ? target.id : null,
      projectId: target.type === "PROJECT" ? target.id : target.projectId,
      after: { content: risk.content, status: risk.status },
    });
    await notifyCollaborationTx(tx, refreshedActor, target, {
      kind: "risk_created",
      eventKey: `pm:risk:${risk.id}:created`,
      title: `${targetLabel(target)}新增风险`,
      summary: `${actorName}提出风险：${risk.content}`,
      entityType: "RiskRecord",
      entityId: risk.id,
      context: { content: risk.content },
    });
    return { riskId: risk.id, targetType: target.type, targetId: target.id };
  });
}

export async function resolveRisk(
  actor: ProjectManagementActor,
  input: unknown,
) {
  const parsed = resolveRiskInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "RiskRecord" WHERE "id" = ${parsed.riskId} FOR UPDATE`;
    const risk = await tx.riskRecord.findUnique({ where: { id: parsed.riskId } });
    if (!risk || (!risk.projectId && !risk.taskId)) throw notFoundError();
    const target = await loadLockedTargetTx(
      tx,
      risk.projectId ? "PROJECT" : "TASK",
      risk.projectId ?? risk.taskId!,
    );
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    assertRiskPermission(refreshedActor, target, "resolve");
    if (target.status === "DRAFT" || target.status === "PENDING_APPROVAL") {
      throw stateConflictError("草稿或待审批对象不能解决风险");
    }
    if (risk.status !== "ACTIVE") {
      throw stateConflictError("该风险已被解决，请刷新后查看");
    }
    const actorName = await actorNameTx(tx, refreshedActor);
    const resolvedAt = new Date();
    const updated = await tx.riskRecord.updateMany({
      where: { id: risk.id, status: "ACTIVE" },
      data: {
        status: "RESOLVED",
        resolvedByAccountId: refreshedActor.accountId,
        resolvedByPersonId: refreshedActor.personId,
        resolvedByName: actorName,
        resolveNote: parsed.resolveNote,
        resolvedAt,
      },
    });
    if (updated.count !== 1) {
      throw stateConflictError("该风险已被解决，请刷新后查看");
    }
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: target.type === "PROJECT" ? "pm.project.risk.resolve" : "pm.task.risk.resolve",
      entityType: "RiskRecord",
      entityId: risk.id,
      taskId: target.type === "TASK" ? target.id : null,
      projectId: target.type === "PROJECT" ? target.id : target.projectId,
      before: { status: "ACTIVE" },
      after: { status: "RESOLVED", resolveNote: parsed.resolveNote },
    });
    await notifyCollaborationTx(tx, refreshedActor, target, {
      kind: "risk_resolved",
      eventKey: `pm:risk:${risk.id}:resolved`,
      title: `${targetLabel(target)}风险已解决`,
      summary: `${actorName}解决风险：${risk.content}；解决说明：${parsed.resolveNote}`,
      entityType: "RiskRecord",
      entityId: risk.id,
      context: { content: risk.content, resolveNote: parsed.resolveNote },
    });
    return { riskId: risk.id, targetType: target.type, targetId: target.id };
  });
}

export async function createComment(
  actor: ProjectManagementActor,
  input: unknown,
) {
  const parsed = createCommentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const target = await loadLockedTargetTx(tx, parsed.targetType, parsed.targetId);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    assertCommentPermission(refreshedActor, target, "create");
    const actorName = await actorNameTx(tx, refreshedActor);
    const comment = await tx.comment.create({
      data: {
        ...targetForeignKey(target),
        content: parsed.content,
        authorAccountId: refreshedActor.accountId,
        authorPersonId: refreshedActor.personId,
        authorName: actorName,
      },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: target.type === "PROJECT" ? "pm.project.comment.create" : "pm.task.comment.create",
      entityType: "Comment",
      entityId: comment.id,
      taskId: target.type === "TASK" ? target.id : null,
      projectId: target.type === "PROJECT" ? target.id : target.projectId,
      after: { content: comment.content },
    });
    await notifyCollaborationTx(tx, refreshedActor, target, {
      kind: "comment_created",
      eventKey: `pm:comment:${comment.id}:created`,
      title: `${targetLabel(target)}新增评论`,
      summary: `${actorName}评论：${comment.content}`,
      entityType: "Comment",
      entityId: comment.id,
      context: { content: comment.content },
    });
    return { commentId: comment.id, targetType: target.type, targetId: target.id };
  });
}

export async function deleteComment(
  actor: ProjectManagementActor,
  input: unknown,
) {
  const parsed = deleteCommentInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Comment" WHERE "id" = ${parsed.commentId} FOR UPDATE`;
    const comment = await tx.comment.findUnique({ where: { id: parsed.commentId } });
    if (!comment || (!comment.projectId && !comment.taskId)) throw notFoundError();
    const target = await loadLockedTargetTx(
      tx,
      comment.projectId ? "PROJECT" : "TASK",
      comment.projectId ?? comment.taskId!,
    );
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    assertCommentPermission(refreshedActor, target, "delete");
    if (comment.deletedAt) {
      throw stateConflictError("该评论已被删除，请刷新后查看");
    }
    const actorName = await actorNameTx(tx, refreshedActor);
    const updated = await tx.comment.updateMany({
      where: { id: comment.id, deletedAt: null },
      data: {
        deletedAt: new Date(),
        deletedByAccountId: refreshedActor.accountId,
        deletedByPersonId: refreshedActor.personId,
        deletedByName: actorName,
      },
    });
    if (updated.count !== 1) {
      throw stateConflictError("该评论已被删除，请刷新后查看");
    }
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: target.type === "PROJECT" ? "pm.project.comment.delete" : "pm.task.comment.delete",
      entityType: "Comment",
      entityId: comment.id,
      taskId: target.type === "TASK" ? target.id : null,
      projectId: target.type === "PROJECT" ? target.id : target.projectId,
      before: {
        authorName: comment.authorName,
        preview: boundedPreview(comment.content),
      },
      after: { deleted: true },
    });
    return { commentId: comment.id, targetType: target.type, targetId: target.id };
  });
}

async function loadLockedTargetTx(
  tx: PrismaTx,
  targetType: TargetType,
  targetId: string,
): Promise<TargetContext> {
  if (targetType === "PROJECT") {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${targetId} FOR UPDATE`;
    const project = await tx.project.findFirst({
      where: { id: targetId, deletedAt: null },
      include: { members: { where: { removedAt: null } } },
    });
    if (!project) throw notFoundError();
    return projectTarget(project);
  }
  await tx.$queryRaw`SELECT "id" FROM "Task" WHERE "id" = ${targetId} FOR UPDATE`;
  const task = await tx.task.findFirst({
    where: { id: targetId, deletedAt: null },
    include: {
      project: { select: { id: true, name: true } },
      members: { where: { removedAt: null } },
    },
  });
  if (!task) throw notFoundError();
  return taskTarget(task);
}

function projectTarget(project: {
  id: string;
  name: string;
  status: ProjectStatus;
  members: Array<{ personId: string; role: "OWNER" | "PARTICIPANT"; removedAt: Date | null }>;
}): Extract<TargetContext, { type: "PROJECT" }> {
  return { type: "PROJECT", ...project };
}

function taskTarget(task: {
  id: string;
  title: string;
  status: TaskStatus;
  projectId: string | null;
  project: { id: string; name: string } | null;
  team: string;
  techGroup: string;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  members: Extract<TargetContext, { type: "TASK" }>["members"];
}): Extract<TargetContext, { type: "TASK" }> {
  return { type: "TASK", ...task };
}

function projectResource(
  target: Extract<TargetContext, { type: "PROJECT" }>,
): AuthorizationProjectResource {
  return { type: "project", id: target.id, status: target.status, members: target.members };
}

function taskResource(
  target: Extract<TargetContext, { type: "TASK" }>,
): AuthorizationTaskResource {
  return {
    type: "task",
    id: target.id,
    status: target.status,
    priority: target.priority,
    team: target.team,
    techGroup: target.techGroup,
    members: target.members,
  };
}

function assertRiskPermission(
  actor: ProjectManagementActor,
  target: TargetContext,
  operation: "create" | "resolve",
) {
  assertAuthorized({
    actor,
    action:
      target.type === "PROJECT"
        ? `project.risk.${operation}`
        : `task.risk.${operation}`,
    resource: target.type === "PROJECT" ? projectResource(target) : taskResource(target),
  });
}

function assertCommentPermission(
  actor: ProjectManagementActor,
  target: TargetContext,
  operation: "create" | "delete",
) {
  assertAuthorized({
    actor,
    action:
      target.type === "PROJECT"
        ? `project.comment.${operation}`
        : `task.comment.${operation}`,
    resource: target.type === "PROJECT" ? projectResource(target) : taskResource(target),
  });
}

function targetForeignKey(target: TargetContext) {
  return target.type === "PROJECT"
    ? { projectId: target.id }
    : { taskId: target.id };
}

async function actorNameTx(tx: PrismaTx, actor: ProjectManagementActor) {
  const person = await tx.person.findUnique({
    where: { id: actor.personId },
    select: { displayName: true },
  });
  return (person?.displayName.trim() || "未知用户").slice(0, 200);
}

async function notifyCollaborationTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  target: TargetContext,
  event: {
    kind: "risk_created" | "risk_resolved" | "comment_created";
    eventKey: string;
    title: string;
    summary: string;
    entityType: "RiskRecord" | "Comment";
    entityId: string;
    context: Record<string, unknown>;
  },
) {
  const memberPersonIds = target.members
    .filter(
      (member) =>
        !member.removedAt &&
        (member.role === "OWNER" || member.role === "PARTICIPANT"),
    )
    .map((member) => member.personId);
  const globalAccountIds = await activeGlobalApprovalAdministratorAccountIdsTx(tx);
  const inactiveGlobalAccountIds = new Set(
    (
      await tx.person.findMany({
        where: {
          accountId: { in: globalAccountIds },
          status: "INACTIVE",
        },
        select: { accountId: true },
      })
    ).flatMap((person) => (person.accountId ? [person.accountId] : [])),
  );
  const recipients = uniqueRecipientsByAccount([
    ...(await recipientsForPersonIdsTx(tx, memberPersonIds)),
    ...(await recipientsForAccountIdsTx(
      tx,
      globalAccountIds.filter(
        (accountId) => !inactiveGlobalAccountIds.has(accountId),
      ),
    )),
  ]).filter((recipient) => recipient.accountId !== actor.accountId);
  await createProjectManagementEventNotificationsTx(tx, {
    actor,
    kind: event.kind,
    category: target.type === "PROJECT" ? "PROJECT" : "TASK",
    eventKey: event.eventKey,
    title: event.title,
    summary: event.summary,
    entityType: event.entityType,
    entityId: event.entityId,
    task:
      target.type === "TASK"
        ? { id: target.id, title: target.title, status: target.status }
        : null,
    project:
      target.type === "PROJECT"
        ? { id: target.id, name: target.name }
        : target.project,
    linkPath:
      target.type === "PROJECT"
        ? `/progress/projects/${target.id}`
        : `/progress/tasks/${target.id}`,
    mandatory: false,
    recipients,
    context: event.context,
  });
}

function targetLabel(target: TargetContext) {
  return target.type === "PROJECT" ? `项目「${target.name}」` : `任务「${target.title}」`;
}

function boundedPreview(content: string) {
  return content.length <= 160 ? content : `${content.slice(0, 160)}…`;
}
