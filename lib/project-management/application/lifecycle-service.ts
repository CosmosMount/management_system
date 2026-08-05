import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type MilestoneReviewResult,
  type RevisionStatus,
  type TaskNodeType,
  type TaskStatus,
  type TerminationOutcome,
  type ProjectManagementNotificationCategory,
  type TaskMemberRole,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  authorize,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import {
  ACTIVE_GLOBAL_APPROVAL_ADMINISTRATOR_REQUIRED,
  activeGlobalApprovalAdministratorAccountIdsTx,
  lockGlobalApprovalAdministratorSetTx,
} from "@/lib/project-management/approval-administrators";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import type { ProjectManagementNotificationPayload } from "@/lib/project-management/notifications/events";
import {
  createProjectManagementEventNotificationsTx,
} from "@/lib/project-management/application/notification-utils";
import {
  activateTaskInputSchema,
  cancelRevisionInputSchema,
  confirmTerminationInputSchema,
  createTaskDraftInputSchema,
  createRevisionInputSchema,
  rejectRevisionInputSchema,
  revisionDecisionInputSchema,
  reviseRejectedRevisionInputSchema,
  reviewMilestoneDecisionInputSchema,
  submitMilestoneReviewInputSchema,
  type CreateTaskDraftInput,
  type CreateRevisionInput,
} from "@/lib/project-management/validations/lifecycle";
import {
  notFoundError,
  planChronologyInvalidError,
  planVersionConflictError,
  staleTaskError,
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import {
  inspectPlanChronology,
  type PlanChronologyCompatibility,
  type PlanChronologyIssue,
} from "@/lib/project-management/domain/plan-chronology";
import { hashPlanSnapshot } from "@/lib/project-management/application/plan-snapshot";

type PrismaTx = Prisma.TransactionClient;

const FEISHU_PROVIDER = "FEISHU";
const DEFAULT_TENANT_ID = "default";
const PROGRESS_LINK = "/progress";

const planNodeInclude = {
  node: {
    include: {
      milestone: true,
      revision: true,
      termination: true,
    },
  },
} satisfies Prisma.PlanVersionNodeInclude;

type PlanEntry = Prisma.PlanVersionNodeGetPayload<{
  include: typeof planNodeInclude;
}>;

type TaskForAuthorization = {
  id: string;
  title: string;
  team: string;
  techGroup: string;
  status: TaskStatus;
  priority: string;
  currentPlanVersionId: string;
  activeMilestoneNodeId: string | null;
  lockVersion: number;
  updatedAt: Date;
  deletedAt: Date | null;
  members: Array<{
    personId: string;
    role: TaskMemberRole;
    removedAt: Date | null;
  }>;
};

type NotificationRecipient = {
  accountId: string;
  openId: string | null;
};

type LifecycleTaskResult = {
  taskId: string;
  currentPlanVersionId: string;
  status: TaskStatus;
  lockVersion: number;
  activeMilestoneNodeId: string | null;
};

export type CreateTaskDraftResult = LifecycleTaskResult & {
  created: boolean;
};

export type RevisionMutationResult = {
  taskId: string;
  revisionNodeId: string;
  targetPlanVersionId: string | null;
  status: RevisionStatus;
  currentPlanVersionId: string;
  lockVersion: number;
};

export type MilestoneReviewMutationResult = {
  taskId: string;
  reviewId: string;
  milestoneNodeId: string;
  result: MilestoneReviewResult;
  taskStatus: TaskStatus;
  activeMilestoneNodeId: string | null;
  lockVersion: number;
};

export async function createTaskDraft(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<CreateTaskDraftResult> {
  assertCurrentTaskComposerPayloadVersion(input);
  const parsed = createTaskDraftInputSchema.parse(input);
  const normalizedInput = {
    ...parsed,
    members: ensureCreatorOwner(parsed.members, actor.personId),
  };
  const requestHash = hashRequest("task.create_draft", normalizedInput);

  return prisma.$transaction(async (tx) => {
    const refreshedActor = await refreshActorTx(tx, actor);
    assertAuthorized({
      actor: refreshedActor,
      action: "task.create",
      resource: {
        type: "system",
        team: parsed.team,
        techGroup: parsed.techGroup,
      },
    });
    await lockIdempotencyKeyTx(
      tx,
      refreshedActor.accountId,
      parsed.idempotencyKey,
    );

    const existing = await tx.taskPlanVersion.findFirst({
      where: {
        createdByAccountId: refreshedActor.accountId,
        idempotencyKey: parsed.idempotencyKey,
      },
      select: {
        id: true,
        taskId: true,
        status: true,
        creationRequestHash: true,
        task: {
          select: {
            status: true,
            currentPlanVersionId: true,
            activeMilestoneNodeId: true,
            lockVersion: true,
          },
        },
      },
    });
    if (existing) {
      if (existing.creationRequestHash !== requestHash) {
        throw stateConflictError("相同请求键已用于不同内容，请刷新后重试");
      }
      return {
        taskId: existing.taskId,
        currentPlanVersionId: existing.task.currentPlanVersionId,
        status: existing.task.status,
        lockVersion: existing.task.lockVersion,
        activeMilestoneNodeId: existing.task.activeMilestoneNodeId,
        created: false,
      };
    }

    await assertCreateTaskReferencesTx(tx, refreshedActor, normalizedInput);
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;

    const taskId = randomUUID();
    const planVersionId = randomUUID();

    await tx.task.create({
      data: {
        id: taskId,
        title: parsed.title,
        description: parsed.description,
        team: parsed.team,
        techGroup: parsed.techGroup,
        priority: parsed.priority,
        status: "DRAFT",
        currentPlanVersionId: planVersionId,
        relatedTaskId: parsed.relatedTaskId,
        createdByAccountId: refreshedActor.accountId,
      },
    });
    await tx.taskPlanVersion.create({
      data: {
        id: planVersionId,
        taskId,
        versionNo: 1,
        status: "CURRENT",
        reason: "初始计划",
        createdByAccountId: refreshedActor.accountId,
        idempotencyKey: parsed.idempotencyKey,
        creationRequestHash: requestHash,
        snapshotHash: "",
        plannedStartAt: parsed.plannedStartAt,
      },
    });
    await createPlanNodesTx(tx, {
      taskId,
      planVersionId,
      actorAccountId: refreshedActor.accountId,
      milestones: parsed.milestones,
      termination: parsed.termination,
      startingSequence: 1,
      carryForward: false,
    });
    const initialPlan = await loadPlanForValidationTx(tx, planVersionId);
    assertAuthoritativePlanValid(initialPlan);
    await tx.taskPlanVersion.update({
      where: { id: planVersionId },
      data: { snapshotHash: hashPlan(initialPlan) },
    });
    await tx.taskMember.createMany({
      data: normalizedInput.members.map((member) => ({
        taskId,
        personId: member.personId,
        role: member.role,
        createdByAccountId: refreshedActor.accountId,
      })),
    });
    if (parsed.tagIds.length > 0) {
      await tx.taskTag.createMany({
        data: parsed.tagIds.map((tagId) => ({ taskId, tagId })),
        skipDuplicates: true,
      });
    }

    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.task.create",
      entityType: "Task",
      entityId: taskId,
      taskId,
      after: jsonValue({
        status: "DRAFT",
        currentPlanVersionId: planVersionId,
        plannedStartAt: parsed.plannedStartAt,
        relatedTaskId: parsed.relatedTaskId,
        milestoneCount: parsed.milestones.length,
        terminationName: parsed.termination.name,
        memberCount: normalizedInput.members.length,
        tagCount: parsed.tagIds.length,
      }),
      reason: "创建 Task 草稿",
    });

    const task = await loadTaskForAuthorizationTx(tx, taskId);
    await notifyTaskMembersTx(tx, {
      actor: refreshedActor,
      task,
      kind: "task_assigned",
      category: "TASK",
      eventKey: `pm:task:assigned:${taskId}:v1`,
      title: "你已被加入 Task",
      summary: `Task「${task.title}」已创建为草稿`,
      entityType: "Task",
      entityId: taskId,
      mandatory: true,
    });

    return {
      taskId,
      currentPlanVersionId: planVersionId,
      status: "DRAFT",
      lockVersion: 0,
      activeMilestoneNodeId: null,
      created: true,
    };
  });
}

function assertCurrentTaskComposerPayloadVersion(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  if (
    Object.prototype.hasOwnProperty.call(input, "revisionApprovalMode") ||
    Object.prototype.hasOwnProperty.call(input, "allowSelfReview")
  ) {
    throw validationError(
      "页面版本已过期，请刷新页面后重试；本地草稿会继续保留",
    );
  }
}

export async function activateTask(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<LifecycleTaskResult> {
  const parsed = activateTaskInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    await lockTaskTx(tx, parsed.taskId);
    const refreshedActor = await refreshActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, parsed.taskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "task.activate",
      resource: taskResource(task),
    });

    if (task.status !== "DRAFT") {
      throw stateConflictError("只有草稿 Task 可以激活");
    }
    if (task.lockVersion !== parsed.expectedLockVersion) {
      throw staleTaskError(task);
    }

    const currentPlan = await loadCurrentPlanEntriesTx(tx, task);
    assertAuthoritativePlanValid(currentPlan);
    if (task.members.every((member) => member.role !== "OWNER")) {
      throw validationError("至少需要一名负责人", {
        members: ["至少需要一名负责人"],
      });
    }
    const firstMilestone = currentPlan.nodes.find(
      (entry) => entry.node.type === "MILESTONE",
    );
    const termination = currentPlan.nodes.find(
      (entry) => entry.node.type === "TERMINATION",
    );
    const firstActiveNode = firstMilestone ?? termination;
    if (!firstActiveNode) throw stateConflictError("计划缺少结束节点");

    const now = new Date();
    await tx.taskNode.update({
      where: { id: firstActiveNode.nodeId },
      data: { status: "ACTIVE" },
    });
    const updated = await tx.task.update({
      where: { id: task.id },
      data: {
        status: "ACTIVE",
        activeMilestoneNodeId: firstMilestone?.nodeId ?? null,
        startedAt: now,
        lockVersion: { increment: 1 },
      },
      select: {
        status: true,
        currentPlanVersionId: true,
        activeMilestoneNodeId: true,
        lockVersion: true,
      },
    });
    await tx.taskPlanVersion.update({
      where: { id: task.currentPlanVersionId },
      data: {
        activatedAt: now,
        snapshotHash: hashPlan(currentPlan),
      },
    });

    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.task.activate",
      entityType: "Task",
      entityId: task.id,
      taskId: task.id,
      before: jsonValue({
        status: task.status,
        lockVersion: task.lockVersion,
        activeMilestoneNodeId: task.activeMilestoneNodeId,
      }),
      after: jsonValue({
        status: updated.status,
        lockVersion: updated.lockVersion,
        activeMilestoneNodeId: updated.activeMilestoneNodeId,
        activeNodeId: firstActiveNode.nodeId,
        activeNodeType: firstActiveNode.node.type,
        activeNodeName: firstActiveNode.node.termination?.name ??
          firstActiveNode.node.milestone?.goal ?? null,
      }),
      reason: "激活 Task",
    });

    await notifyTaskMembersTx(tx, {
      actor: refreshedActor,
      task: { ...task, status: updated.status },
      kind: "task_activated",
      category: "TASK",
      eventKey: `pm:task:activated:${task.id}:${updated.lockVersion}`,
      title: "Task 已激活",
      summary: firstMilestone
        ? `Task「${task.title}」已开始执行`
        : `Task「${task.title}」已开始执行，当前节点：${termination?.node.termination?.name ?? "Terminal"}`,
      entityType: "Task",
      entityId: task.id,
      mandatory: false,
    });

    return {
      taskId: task.id,
      currentPlanVersionId: updated.currentPlanVersionId,
      status: updated.status,
      lockVersion: updated.lockVersion,
      activeMilestoneNodeId: updated.activeMilestoneNodeId,
    };
  });
}

export async function createRevision(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RevisionMutationResult & { created: boolean }> {
  const parsed = createRevisionInputSchema.parse(input);
  const requestHash = hashRequest("revision.create", parsed);

  return prisma.$transaction(async (tx) => {
    await lockTaskTx(tx, parsed.taskId);
    const refreshedActor = await refreshActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, parsed.taskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "revision.create",
      resource: taskResource(task),
    });
    assertTaskActiveForPlanChange(task);
    await lockIdempotencyKeyTx(
      tx,
      refreshedActor.accountId,
      parsed.idempotencyKey,
    );

    const existing = await tx.taskPlanVersion.findFirst({
      where: {
        createdByAccountId: refreshedActor.accountId,
        idempotencyKey: parsed.idempotencyKey,
      },
      select: {
        id: true,
        taskId: true,
        status: true,
        revisionNodeId: true,
        creationRequestHash: true,
        revisionNode: { select: { status: true } },
      },
    });
    if (existing) {
      if (existing.creationRequestHash !== requestHash) {
        throw stateConflictError("相同请求键已用于不同内容，请刷新后重试");
      }
      return {
        taskId: existing.taskId,
        revisionNodeId: existing.revisionNodeId ?? "",
        targetPlanVersionId: existing.id,
        status: existing.revisionNode?.status ?? "PENDING_APPROVAL",
        currentPlanVersionId: task.currentPlanVersionId,
        lockVersion: task.lockVersion,
        created: false,
      };
    }

    assertRevisionBaseline(task, parsed);
    const activeCandidate = await tx.taskPlanVersion.findFirst({
      where: {
        taskId: task.id,
        status: "DRAFT",
        revisionNodeId: { not: null },
      },
      select: { id: true },
    });
    if (activeCandidate) {
      throw stateConflictError("当前 Task 已有待处理的 Revision");
    }
    const currentPlan = await loadCurrentPlanEntriesTx(tx, task);
    assertLegacyCurrentPlanUsableAsRepairBase(currentPlan);
    await assertRevisionAtValidTx(tx, {
      taskId: task.id,
      revisionAt: parsed.revisionAt,
      plannedStartAt: currentPlan.plannedStartAt,
      terminalAt: parsed.termination.plannedAt,
      completedMilestoneTimes: currentPlan.nodes.flatMap((entry) =>
        entry.node.milestone && entry.node.status === "COMPLETED"
          ? [entry.node.milestone.expectedCompletedAt]
          : [],
      ),
    });

    const carriedEntries = currentPlan.nodes.filter(isRevisionCarryForwardEntry);
    const targetPlanVersionId = randomUUID();
    const revisionTaskNodeId = randomUUID();
    const revisionNodeId = randomUUID();
    const versionNo = await nextPlanVersionNoTx(tx, task.id);
    await tx.taskPlanVersion.create({
      data: {
        id: targetPlanVersionId,
        taskId: task.id,
        versionNo,
        status: "DRAFT",
        baseVersionId: task.currentPlanVersionId,
        reason: parsed.reason,
        createdByAccountId: refreshedActor.accountId,
        idempotencyKey: parsed.idempotencyKey,
        creationRequestHash: requestHash,
        snapshotHash: "",
        plannedStartAt: currentPlan.plannedStartAt,
      },
    });
    for (const [index, entry] of carriedEntries.entries()) {
      await tx.planVersionNode.create({
        data: {
          planVersionId: targetPlanVersionId,
          nodeId: entry.nodeId,
          sequence: index + 1,
          isCarryForward: true,
        },
      });
    }
    await tx.taskNode.create({
      data: {
        id: revisionTaskNodeId,
        taskId: task.id,
        type: "REVISION",
        status: "PENDING",
        businessDescription: parsed.reason,
        createdByAccountId: refreshedActor.accountId,
      },
    });
    await tx.revisionNode.create({
      data: {
        id: revisionNodeId,
        nodeId: revisionTaskNodeId,
        reason: parsed.reason,
        revisionAt: parsed.revisionAt,
        reviewRound: 1,
        basePlanVersionId: task.currentPlanVersionId,
        baseTaskLockVersion: task.lockVersion,
        status: "PENDING_APPROVAL",
        affectedSummary: jsonValue(
          summarizeRevisionCandidate(currentPlan.nodes, carriedEntries, parsed),
        ),
      },
    });
    await tx.planVersionNode.create({
      data: {
        planVersionId: targetPlanVersionId,
        nodeId: revisionTaskNodeId,
        sequence: carriedEntries.length + 1,
      },
    });
    await tx.taskPlanVersion.update({
      where: { id: targetPlanVersionId },
      data: { revisionNodeId },
    });
    await createPlanNodesTx(tx, {
      taskId: task.id,
      planVersionId: targetPlanVersionId,
      actorAccountId: refreshedActor.accountId,
      milestones: parsed.replacementMilestones,
      termination: parsed.termination,
      startingSequence: carriedEntries.length + 2,
      carryForward: false,
    });
    const targetPlan = await loadPlanForValidationTx(tx, targetPlanVersionId);
    assertRevisionTargetPlanValid(targetPlan);
    await tx.taskPlanVersion.update({
      where: { id: targetPlanVersionId },
      data: { snapshotHash: hashPlan(targetPlan) },
    });

    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.revision.create",
      entityType: "RevisionNode",
      entityId: revisionNodeId,
      taskId: task.id,
      after: jsonValue({
        status: "PENDING_APPROVAL",
        basePlanVersionId: task.currentPlanVersionId,
        targetPlanVersionId,
        baseTaskLockVersion: task.lockVersion,
        revisionAt: parsed.revisionAt,
        reviewRound: 1,
        replacementMilestoneCount: parsed.replacementMilestones.length,
        terminationName: parsed.termination.name,
      }),
      reason: parsed.reason,
    });
    await notifyGlobalAdministratorsTx(tx, {
      actor: refreshedActor,
      task,
      kind: "revision_pending_review",
      category: "REVISION",
      eventKey: `pm:revision:pending_review:${revisionNodeId}:round:1`,
      title: "计划修订待审批",
      summary: `Task「${task.title}」有新的计划修订待审批`,
      entityType: "RevisionNode",
      entityId: revisionNodeId,
      mandatory: true,
    });

    return {
      taskId: task.id,
      revisionNodeId,
      targetPlanVersionId,
      status: "PENDING_APPROVAL",
      currentPlanVersionId: task.currentPlanVersionId,
      lockVersion: task.lockVersion,
      created: true,
    };
  });
}

export async function reviseRejectedRevision(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RevisionMutationResult> {
  const parsed = reviseRejectedRevisionInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task, revision, targetPlanVersionId } =
      await loadRevisionForMutationTx(tx, actor, parsed.revisionNodeId);
    assertCanManageRevision(refreshedActor, task, revision);
    assertTaskActiveForPlanChange(task);
    if (revision.status !== "REJECTED") {
      throw stateConflictError("只有已驳回的 Revision 可以修改后重新送审");
    }
    if (!targetPlanVersionId || !revision.targetPlanVersion) {
      throw stateConflictError("Revision 缺少候选计划");
    }
    if (
      revision.targetPlanVersion.status !== "DRAFT" ||
      revision.targetPlanVersion.updatedAt.getTime() !==
        parsed.expectedTargetPlanUpdatedAt.getTime()
    ) {
      throw planVersionConflictError("Revision 候选计划已更新，请刷新后重试");
    }
    if (
      revision.basePlanVersionId !== task.currentPlanVersionId ||
      revision.baseTaskLockVersion !== task.lockVersion
    ) {
      throw planVersionConflictError();
    }

    const currentPlan = await loadCurrentPlanEntriesTx(tx, task);
    await assertRevisionAtValidTx(tx, {
      taskId: task.id,
      revisionAt: parsed.revisionAt,
      plannedStartAt: currentPlan.plannedStartAt,
      terminalAt: parsed.termination.plannedAt,
      completedMilestoneTimes: currentPlan.nodes.flatMap((entry) =>
        entry.node.milestone && entry.node.status === "COMPLETED"
          ? [entry.node.milestone.expectedCompletedAt]
          : [],
      ),
    });

    const targetPlan = await loadPlanForValidationTx(tx, targetPlanVersionId);
    assertRevisionTargetPlanValid(targetPlan);
    assertRevisionStartUnchanged(
      currentPlan.plannedStartAt,
      targetPlan.plannedStartAt,
    );
    const beforePlanAudit = revisionPlanAuditState(targetPlan);
    const revisionEntryIndex = targetPlan.nodes.findIndex(
      (entry) => entry.nodeId === revision.nodeId,
    );
    if (revisionEntryIndex < 0) {
      throw stateConflictError("Revision 候选计划结构不完整");
    }
    const replaceableEntries = targetPlan.nodes.slice(revisionEntryIndex + 1);
    const replaceableNodeIds = replaceableEntries.map((entry) => entry.nodeId);
    if (replaceableNodeIds.length > 0) {
      await tx.planVersionNode.deleteMany({
        where: { planVersionId: targetPlanVersionId, nodeId: { in: replaceableNodeIds } },
      });
      await tx.milestoneNode.deleteMany({
        where: { nodeId: { in: replaceableNodeIds } },
      });
      await tx.terminationNode.deleteMany({
        where: { nodeId: { in: replaceableNodeIds } },
      });
      await tx.taskNode.deleteMany({
        where: { id: { in: replaceableNodeIds } },
      });
    }

    await tx.taskPlanVersion.update({
      where: { id: targetPlanVersionId },
      data: {
        reason: parsed.reason,
        snapshotHash: "",
      },
    });
    await tx.taskNode.update({
      where: { id: revision.nodeId },
      data: { businessDescription: parsed.reason },
    });
    await tx.revisionNode.update({
      where: { id: parsed.revisionNodeId },
      data: {
        reason: parsed.reason,
        revisionAt: parsed.revisionAt,
        status: "PENDING_APPROVAL",
        reviewRound: { increment: 1 },
        reviewedAt: null,
        reviewedByAccountId: null,
        reviewComment: "",
        affectedSummary: jsonValue({
          carriedNodeCount: revisionEntryIndex,
          replacementMilestoneCount: parsed.replacementMilestones.length,
          terminationName: parsed.termination.name,
        }),
      },
    });
    await createPlanNodesTx(tx, {
      taskId: task.id,
      planVersionId: targetPlanVersionId,
      actorAccountId: refreshedActor.accountId,
      milestones: parsed.replacementMilestones,
      termination: parsed.termination,
      startingSequence: revisionEntryIndex + 2,
      carryForward: false,
    });
    const updatedTargetPlan = await loadPlanForValidationTx(
      tx,
      targetPlanVersionId,
    );
    assertRevisionTargetPlanValid(updatedTargetPlan);
    const afterPlanAudit = revisionPlanAuditState(updatedTargetPlan);
    await tx.taskPlanVersion.update({
      where: { id: targetPlanVersionId },
      data: { snapshotHash: afterPlanAudit.snapshotHash },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.revision.resubmit",
      entityType: "RevisionNode",
      entityId: parsed.revisionNodeId,
      taskId: task.id,
      before: jsonValue({
        status: revision.status,
        reviewRound: revision.reviewRound,
        targetPlanVersionId,
        targetPlanUpdatedAt: revision.targetPlanVersion.updatedAt,
        plan: beforePlanAudit,
      }),
      after: jsonValue({
        status: "PENDING_APPROVAL",
        revisionAt: parsed.revisionAt,
        reviewRound: revision.reviewRound + 1,
        targetPlanVersionId,
        replacementMilestoneCount: parsed.replacementMilestones.length,
        terminationName: parsed.termination.name,
        plan: afterPlanAudit,
        changes: summarizeRevisionPlanChanges(targetPlan, updatedTargetPlan),
      }),
      reason: parsed.reason,
    });
    await notifyGlobalAdministratorsTx(tx, {
      actor: refreshedActor,
      task,
      kind: "revision_pending_review",
      category: "REVISION",
      eventKey: `pm:revision:pending_review:${parsed.revisionNodeId}:round:${revision.reviewRound + 1}`,
      title: "计划修订重新待审批",
      summary: `Task「${task.title}」的计划修订已修改并重新送审`,
      entityType: "RevisionNode",
      entityId: parsed.revisionNodeId,
      mandatory: true,
    });
    return {
      taskId: task.id,
      revisionNodeId: parsed.revisionNodeId,
      targetPlanVersionId,
      status: "PENDING_APPROVAL",
      currentPlanVersionId: task.currentPlanVersionId,
      lockVersion: task.lockVersion,
    };
  });
}

export async function approveRevision(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RevisionMutationResult> {
  const parsed = revisionDecisionInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task, revision } =
      await loadRevisionForMutationTx(tx, actor, parsed.revisionNodeId);
    assertAuthorized({
      actor: refreshedActor,
      action: "revision.review",
      resource: taskResource(task),
    });
    if (revision.status !== "PENDING_APPROVAL") {
      if (revision.status === "EFFECTIVE") {
        return {
          taskId: task.id,
          revisionNodeId: parsed.revisionNodeId,
          targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
          status: "EFFECTIVE",
          currentPlanVersionId: task.currentPlanVersionId,
          lockVersion: task.lockVersion,
        };
      }
      throw stateConflictError("只有待审批 Revision 可以通过");
    }
    return applyRevisionTx(tx, {
      actor: refreshedActor,
      task,
      revisionNodeId: parsed.revisionNodeId,
      reviewComment: parsed.comment,
      allowedRevisionStatuses: ["PENDING_APPROVAL"],
    });
  });
}

export async function rejectRevision(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RevisionMutationResult> {
  const parsed = rejectRevisionInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task, revision } =
      await loadRevisionForMutationTx(tx, actor, parsed.revisionNodeId);
    assertAuthorized({
      actor: refreshedActor,
      action: "revision.review",
      resource: taskResource(task),
    });
    if (revision.status !== "PENDING_APPROVAL") {
      if (revision.status === "REJECTED") {
        return {
          taskId: task.id,
          revisionNodeId: parsed.revisionNodeId,
          targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
          status: "REJECTED",
          currentPlanVersionId: task.currentPlanVersionId,
          lockVersion: task.lockVersion,
        };
      }
      throw stateConflictError("只有待审批 Revision 可以驳回");
    }
    const rejected = await tx.revisionNode.updateMany({
      where: { id: parsed.revisionNodeId, status: "PENDING_APPROVAL" },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedByAccountId: refreshedActor.accountId,
        reviewComment: parsed.comment,
      },
    });
    if (rejected.count !== 1) {
      throw stateConflictError("只有待审批 Revision 可以驳回");
    }
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.revision.reject",
      entityType: "RevisionNode",
      entityId: parsed.revisionNodeId,
      taskId: task.id,
      before: jsonValue({
        status: revision.status,
        reviewRound: revision.reviewRound,
      }),
      after: jsonValue({
        status: "REJECTED",
        reviewRound: revision.reviewRound,
      }),
      reason: parsed.comment,
    });
    await notifyRevisionResultTx(tx, {
      actor: refreshedActor,
      task,
      revisionNodeId: parsed.revisionNodeId,
      title: "计划修订已驳回",
      summary: parsed.comment,
      eventKey: `pm:revision:result:${parsed.revisionNodeId}:round:${revision.reviewRound}:rejected`,
      recipients: await revisionCreatorAndOwnersTx(tx, task, revision),
    });

    return {
      taskId: task.id,
      revisionNodeId: parsed.revisionNodeId,
      targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
      status: "REJECTED",
      currentPlanVersionId: task.currentPlanVersionId,
      lockVersion: task.lockVersion,
    };
  });
}

export async function cancelRevision(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<RevisionMutationResult> {
  const parsed = cancelRevisionInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task, revision } =
      await loadRevisionForMutationTx(tx, actor, parsed.revisionNodeId);
    assertCanManageRevision(refreshedActor, task, revision);
    if (
      revision.status !== "PENDING_APPROVAL" &&
      revision.status !== "REJECTED"
    ) {
      if (revision.status === "CANCELLED") {
        return {
          taskId: task.id,
          revisionNodeId: parsed.revisionNodeId,
          targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
          status: "CANCELLED",
          currentPlanVersionId: task.currentPlanVersionId,
          lockVersion: task.lockVersion,
        };
      }
      throw stateConflictError("该 Revision 已生效，不能取消");
    }
    const cancelled = await tx.revisionNode.updateMany({
      where: {
        id: parsed.revisionNodeId,
        status: { in: ["PENDING_APPROVAL", "REJECTED"] },
      },
      data: {
        status: "CANCELLED",
        reviewedAt: new Date(),
        reviewedByAccountId: refreshedActor.accountId,
        reviewComment: parsed.comment,
      },
    });
    if (cancelled.count !== 1) {
      throw stateConflictError("该 Revision 已生效，不能取消");
    }
    if (revision.targetPlanVersion?.id) {
      const abandoned = await tx.taskPlanVersion.updateMany({
        where: { id: revision.targetPlanVersion.id, status: "DRAFT" },
        data: { status: "ABANDONED" },
      });
      if (abandoned.count !== 1) {
        throw stateConflictError("Revision 目标计划已失效，请刷新后重试");
      }
      await tx.taskNode.updateMany({
        where: {
          planVersionEntries: {
            some: {
              planVersionId: revision.targetPlanVersion.id,
              isCarryForward: false,
            },
          },
          status: { in: ["PENDING", "ACTIVE"] },
          type: { in: ["MILESTONE", "REVISION", "TERMINATION"] },
        },
        data: { status: "CANCELLED" },
      });
    }
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.revision.cancel",
      entityType: "RevisionNode",
      entityId: parsed.revisionNodeId,
      taskId: task.id,
      before: jsonValue({ status: revision.status }),
      after: jsonValue({
        status: "CANCELLED",
        targetPlanVersionStatus: "ABANDONED",
      }),
      reason: parsed.comment,
    });

    return {
      taskId: task.id,
      revisionNodeId: parsed.revisionNodeId,
      targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
      status: "CANCELLED",
      currentPlanVersionId: task.currentPlanVersionId,
      lockVersion: task.lockVersion,
    };
  });
}

export async function submitMilestoneForReview(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<MilestoneReviewMutationResult & { created: boolean }> {
  const parsed = submitMilestoneReviewInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const milestoneTaskId = await loadMilestoneTaskIdTx(
      tx,
      parsed.milestoneNodeId,
    );
    await lockTaskTx(tx, milestoneTaskId);
    const milestone = await loadMilestoneWithTaskTx(tx, parsed.milestoneNodeId);
    const refreshedActor = await refreshActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, milestoneTaskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "milestone.submit_review",
      resource: taskResource(task),
    });
    if (
      task.status !== "ACTIVE" ||
      milestone.node.status !== "ACTIVE" ||
      task.activeMilestoneNodeId !== milestone.nodeId
    ) {
      throw stateConflictError("只有当前 Active Milestone 可以提交验收");
    }
    await assertNodeInCurrentPlanTx(tx, task, milestone.nodeId, "MILESTONE");

    const existing = await tx.milestoneReview.findUnique({
      where: {
        milestoneNodeId_idempotencyKey: {
          milestoneNodeId: milestone.id,
          idempotencyKey: parsed.idempotencyKey,
        },
      },
      select: { id: true, result: true },
    });
    if (existing) {
      return {
        taskId: task.id,
        reviewId: existing.id,
        milestoneNodeId: milestone.nodeId,
        result: existing.result,
        taskStatus: task.status,
        activeMilestoneNodeId: task.activeMilestoneNodeId,
        lockVersion: task.lockVersion,
        created: false,
      };
    }
    const pendingReview = await tx.milestoneReview.findFirst({
      where: {
        milestoneNodeId: milestone.id,
        result: "PENDING",
        revokedAt: null,
      },
      select: { id: true, result: true },
      orderBy: { createdAt: "desc" },
    });
    if (pendingReview) {
      return {
        taskId: task.id,
        reviewId: pendingReview.id,
        milestoneNodeId: milestone.nodeId,
        result: pendingReview.result,
        taskStatus: task.status,
        activeMilestoneNodeId: task.activeMilestoneNodeId,
        lockVersion: task.lockVersion,
        created: false,
      };
    }

    const review = await tx.milestoneReview.create({
      data: {
        milestoneNodeId: milestone.id,
        result: "PENDING",
        submittedByAccountId: refreshedActor.accountId,
        idempotencyKey: parsed.idempotencyKey,
        evidences: {
          create: parsed.evidences.map((evidence, index) => ({
            kind: evidence.kind,
            sortOrder: evidence.sortOrder ?? index,
            externalUrl:
              evidence.kind === "LINK" ? evidence.externalUrl : null,
            note: evidence.note ?? "",
          })),
        },
      },
      select: { id: true, result: true },
    });
    await tx.milestoneNode.update({
      where: { id: milestone.id },
      data: { submittedForReviewAt: new Date() },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.milestone.review.submit",
      entityType: "MilestoneReview",
      entityId: review.id,
      taskId: task.id,
      after: jsonValue({
        milestoneNodeId: milestone.nodeId,
        result: review.result,
        evidenceCount: parsed.evidences.length,
      }),
      reason: "提交 Milestone 验收",
    });
    await notifyGlobalAdministratorsTx(tx, {
      actor: refreshedActor,
      task,
      kind: "milestone_review_submitted",
      category: "REVIEW",
      eventKey: `pm:milestone:review_submitted:${review.id}`,
      title: "Milestone 待验收",
      summary: `Task「${task.title}」有 Milestone 待验收`,
      entityType: "MilestoneReview",
      entityId: review.id,
      mandatory: true,
    });

    return {
      taskId: task.id,
      reviewId: review.id,
      milestoneNodeId: milestone.nodeId,
      result: review.result,
      taskStatus: task.status,
      activeMilestoneNodeId: task.activeMilestoneNodeId,
      lockVersion: task.lockVersion,
      created: true,
    };
  });
}

export async function reviewMilestone(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<MilestoneReviewMutationResult> {
  const parsed = reviewMilestoneDecisionInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const reviewTaskId = await loadMilestoneReviewTaskIdTx(tx, parsed.reviewId);
    await lockTaskTx(tx, reviewTaskId);
    const review = await loadMilestoneReviewForMutationTx(tx, parsed.reviewId);
    const refreshedActor = await refreshActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, reviewTaskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "milestone.review",
      resource: taskResource(task),
    });
    const newerReview = await tx.milestoneReview.findFirst({
      where: {
        milestoneNodeId: review.milestoneNodeId,
        revokedAt: null,
        createdAt: { gt: review.createdAt },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    if (newerReview) {
      throw stateConflictError("只能处理最新的 Milestone 验收记录");
    }
    if (review.result !== "PENDING" || review.revokedAt) {
      if (review.result === parsed.result) {
        return {
          taskId: task.id,
          reviewId: review.id,
          milestoneNodeId: review.milestoneNode.nodeId,
          result: review.result,
          taskStatus: task.status,
          activeMilestoneNodeId: task.activeMilestoneNodeId,
          lockVersion: task.lockVersion,
        };
      }
      throw stateConflictError("该验收记录已处理");
    }
    if (
      task.status !== "ACTIVE" ||
      review.milestoneNode.node.status !== "ACTIVE" ||
      task.activeMilestoneNodeId !== review.milestoneNode.nodeId
    ) {
      throw stateConflictError("只有当前 Active Milestone 的验收记录可以处理");
    }
    await assertNodeInCurrentPlanTx(
      tx,
      task,
      review.milestoneNode.nodeId,
      "MILESTONE",
    );

    let nextActiveMilestoneNodeId: string | null = task.activeMilestoneNodeId;
    let taskStatus: TaskStatus = task.status;
    let lockVersion = task.lockVersion;
    const now = new Date();
    const updatedReview = await tx.milestoneReview.updateMany({
      where: {
        id: review.id,
        result: "PENDING",
        revokedAt: null,
      },
      data: {
        result: parsed.result,
        reviewerAccountId: refreshedActor.accountId,
        reviewedAt: now,
        comment: parsed.comment,
      },
    });
    if (updatedReview.count !== 1) {
      throw stateConflictError("该验收记录已处理");
    }

    if (parsed.result === "APPROVED") {
      await tx.milestoneNode.update({
        where: { id: review.milestoneNode.id },
        data: { completedAt: now },
      });
      await tx.taskNode.update({
        where: { id: review.milestoneNode.nodeId },
        data: { status: "COMPLETED" },
      });
      const advanced = await advanceCurrentPlanAfterNodeTx(
        tx,
        task,
        review.milestoneNode.nodeId,
      );
      nextActiveMilestoneNodeId = advanced.activeMilestoneNodeId;
      const updatedTask = await tx.task.update({
        where: { id: task.id },
        data: {
          activeMilestoneNodeId: nextActiveMilestoneNodeId,
          lockVersion: { increment: 1 },
        },
        select: {
          status: true,
          activeMilestoneNodeId: true,
          lockVersion: true,
        },
      });
      taskStatus = updatedTask.status;
      lockVersion = updatedTask.lockVersion;
    }

    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.milestone.review",
      entityType: "MilestoneReview",
      entityId: review.id,
      taskId: task.id,
      before: jsonValue({
        result: review.result,
        activeMilestoneNodeId: task.activeMilestoneNodeId,
        lockVersion: task.lockVersion,
      }),
      after: jsonValue({
        result: parsed.result,
        activeMilestoneNodeId: nextActiveMilestoneNodeId,
        lockVersion,
      }),
      reason: parsed.comment,
    });
    await notifyMilestoneReviewResultTx(tx, {
      actor: refreshedActor,
      task,
      reviewId: review.id,
      result: parsed.result,
      summary: parsed.comment || `验收结果：${parsed.result}`,
      recipients: await reviewSubmitterAndOwnersTx(tx, task, review),
    });

    return {
      taskId: task.id,
      reviewId: review.id,
      milestoneNodeId: review.milestoneNode.nodeId,
      result: parsed.result,
      taskStatus,
      activeMilestoneNodeId: nextActiveMilestoneNodeId,
      lockVersion,
    };
  });
}

export async function confirmTermination(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<LifecycleTaskResult & { outcome: TerminationOutcome }> {
  const parsed = confirmTerminationInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    await lockTaskTx(tx, parsed.taskId);
    const refreshedActor = await refreshActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, parsed.taskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "task.terminate",
      resource: taskResource(task),
    });
    const termination = await loadTerminationWithNodeTx(
      tx,
      parsed.terminationNodeId,
    );
    if (termination.node.taskId !== task.id) {
      throw validationError("结束节点不属于该 Task");
    }
    if (termination.outcome) {
      if (termination.outcome === parsed.outcome) {
        return {
          taskId: task.id,
          currentPlanVersionId: task.currentPlanVersionId,
          status: outcomeToTaskStatus(termination.outcome),
          lockVersion: task.lockVersion,
          activeMilestoneNodeId: task.activeMilestoneNodeId,
          outcome: termination.outcome,
        };
      }
      throw stateConflictError("该 Task 已使用其他结果结束");
    }
    if (task.status !== "ACTIVE") {
      throw stateConflictError("只有执行中的 Task 可以确认结束");
    }
    if (task.lockVersion !== parsed.expectedLockVersion) {
      throw staleTaskError(task);
    }
    const currentPlan = await loadCurrentPlanEntriesTx(tx, task);
    assertLegacyCurrentPlanUsableAsRepairBase(currentPlan);
    const terminationEntryIndex = currentPlan.nodes.findIndex(
      (entry) => entry.nodeId === termination.nodeId,
    );
    if (terminationEntryIndex !== currentPlan.nodes.length - 1) {
      throw stateConflictError("结束节点必须是当前计划最后一个节点");
    }
    if (parsed.outcome === "SUCCESS") {
      const unfinishedMilestone = currentPlan.nodes.find(
        (entry) =>
          entry.node.type === "MILESTONE" &&
          entry.node.status !== "COMPLETED",
      );
      if (unfinishedMilestone) {
        throw stateConflictError("成功结束前必须完成所有前置 Milestone");
      }
    }

    const now = new Date();
    await tx.terminationNode.update({
      where: { id: termination.id },
      data: {
        outcome: parsed.outcome,
        reason: parsed.reason,
        summary: parsed.summary,
        confirmedByAccountId: refreshedActor.accountId,
        confirmedAt: now,
      },
    });
    await tx.taskNode.update({
      where: { id: termination.nodeId },
      data: { status: "COMPLETED" },
    });
    const unfinishedNodeIds = currentPlan.nodes
      .filter(
        (entry) =>
          entry.nodeId !== termination.nodeId &&
          entry.node.status !== "COMPLETED" &&
          entry.node.status !== "REVISED",
      )
      .map((entry) => entry.nodeId);
    if (unfinishedNodeIds.length > 0) {
      await tx.taskNode.updateMany({
        where: { id: { in: unfinishedNodeIds } },
        data: { status: "CANCELLED" },
      });
    }
    const updated = await tx.task.update({
      where: { id: task.id },
      data: {
        status: outcomeToTaskStatus(parsed.outcome),
        activeMilestoneNodeId: null,
        endedAt: now,
        lockVersion: { increment: 1 },
      },
      select: {
        status: true,
        currentPlanVersionId: true,
        activeMilestoneNodeId: true,
        lockVersion: true,
      },
    });

    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.termination.confirm",
      entityType: "TerminationNode",
      entityId: termination.id,
      taskId: task.id,
      before: jsonValue({
        taskStatus: task.status,
        lockVersion: task.lockVersion,
        outcome: termination.outcome,
        name: termination.name,
      }),
      after: jsonValue({
        taskStatus: updated.status,
        lockVersion: updated.lockVersion,
        outcome: parsed.outcome,
        name: termination.name,
        cancelledNodeCount: unfinishedNodeIds.length,
      }),
      reason: parsed.reason,
    });
    await notifyTaskMembersTx(tx, {
      actor: refreshedActor,
      task,
      kind: "task_terminated",
      category: "TASK",
      eventKey: `pm:task:terminated:${termination.nodeId}`,
      title: "Task 已结束",
      summary: `Task「${task.title}」已结束（${termination.name}）：${parsed.outcome}`,
      entityType: "TerminationNode",
      entityId: termination.id,
      mandatory: true,
    });

    return {
      taskId: task.id,
      currentPlanVersionId: updated.currentPlanVersionId,
      status: updated.status,
      lockVersion: updated.lockVersion,
      activeMilestoneNodeId: updated.activeMilestoneNodeId,
      outcome: parsed.outcome,
    };
  });
}

async function applyRevisionTx(
  tx: PrismaTx,
  {
    actor,
    task,
    revisionNodeId,
    reviewComment,
    allowedRevisionStatuses,
  }: {
    actor: ProjectManagementActor;
    task: TaskForAuthorization;
    revisionNodeId: string;
    reviewComment: string;
    allowedRevisionStatuses: RevisionStatus[];
  },
): Promise<RevisionMutationResult> {
  const revision = await tx.revisionNode.findUnique({
    where: { id: revisionNodeId },
    include: {
      node: true,
      targetPlanVersion: true,
    },
  });
  if (!revision) throw notFoundError();
  const targetPlanVersionId = revision.targetPlanVersion?.id;
  if (!targetPlanVersionId) {
    throw stateConflictError("Revision 缺少目标计划版本");
  }
  if (!allowedRevisionStatuses.includes(revision.status)) {
    throw stateConflictError("Revision 状态已变化，请刷新后重试");
  }
  if (revision.targetPlanVersion?.status !== "DRAFT") {
    throw stateConflictError("Revision 目标计划已失效，请刷新后重试");
  }
  if (revision.basePlanVersionId !== task.currentPlanVersionId) {
    throw planVersionConflictError();
  }
  if (revision.baseTaskLockVersion !== task.lockVersion) {
    throw planVersionConflictError();
  }
  if (task.status !== "ACTIVE") {
    throw stateConflictError("只有执行中的 Task 可以生效 Revision");
  }

  await assertRevisionTargetValidTx(tx, task, revision, targetPlanVersionId);
  const baseEntries = await loadPlanEntriesTx(tx, revision.basePlanVersionId);
  const targetPlan = await loadPlanForValidationTx(tx, targetPlanVersionId);
  assertRevisionTargetPlanValid(targetPlan);
  const targetEntries = targetPlan.nodes;
  assertCompletedPrefixUnchanged(baseEntries, targetEntries);
  const carriedBaseNodeIds = new Set(
    targetEntries
      .filter((entry) => entry.isCarryForward)
      .map((entry) => entry.nodeId),
  );
  const replacedNodeIds = baseEntries
    .filter(
      (entry) =>
        !carriedBaseNodeIds.has(entry.nodeId) &&
        entry.node.type !== "REVISION" &&
        entry.node.status !== "COMPLETED",
    )
    .map((entry) => entry.nodeId);
  const now = new Date();
  const revisionMarkedEffective = await tx.revisionNode.updateMany({
    where: {
      id: revisionNodeId,
      status: { in: allowedRevisionStatuses },
    },
    data: {
      status: "EFFECTIVE",
      reviewedAt: now,
      reviewedByAccountId: actor.accountId,
      effectiveAt: now,
      reviewComment,
    },
  });
  if (revisionMarkedEffective.count !== 1) {
    throw stateConflictError("Revision 状态已变化，请刷新后重试");
  }
  const oldCurrentUpdated = await tx.taskPlanVersion.updateMany({
    where: { id: task.currentPlanVersionId, status: "CURRENT" },
    data: { status: "HISTORICAL" },
  });
  if (oldCurrentUpdated.count !== 1) {
    throw planVersionConflictError();
  }
  const targetCurrentUpdated = await tx.taskPlanVersion.updateMany({
    where: { id: targetPlanVersionId, status: "DRAFT" },
    data: {
      status: "CURRENT",
      activatedAt: now,
      snapshotHash: hashPlan(targetPlan),
    },
  });
  if (targetCurrentUpdated.count !== 1) {
    throw stateConflictError("Revision 目标计划已失效，请刷新后重试");
  }
  if (replacedNodeIds.length > 0) {
    await tx.taskNode.updateMany({
      where: {
        id: { in: replacedNodeIds },
        status: { in: ["PENDING", "ACTIVE"] },
      },
      data: { status: "REVISED" },
    });
  }
  await tx.taskNode.update({
    where: { id: revision.nodeId },
    data: { status: "COMPLETED" },
  });

  const activeMilestoneNodeId = await activateNextMilestoneInPlanTx(
    tx,
    targetEntries,
  );
  const updatedTask = await tx.task.update({
    where: { id: task.id },
    data: {
      currentPlanVersionId: targetPlanVersionId,
      activeMilestoneNodeId,
      lockVersion: { increment: 1 },
    },
    select: {
      currentPlanVersionId: true,
      lockVersion: true,
      activeMilestoneNodeId: true,
    },
  });
  const taskAfterPlanSwitch = {
    ...task,
    currentPlanVersionId: updatedTask.currentPlanVersionId,
  };
  await createDomainAuditEventTx(tx, {
    actorAccountId: actor.accountId,
    actorPersonId: actor.personId,
    action: "pm.revision.apply",
    entityType: "RevisionNode",
    entityId: revisionNodeId,
    taskId: task.id,
    before: jsonValue({
      currentPlanVersionId: task.currentPlanVersionId,
      lockVersion: task.lockVersion,
      revisionStatus: revision.status,
    }),
    after: jsonValue({
      currentPlanVersionId: updatedTask.currentPlanVersionId,
      lockVersion: updatedTask.lockVersion,
      activeMilestoneNodeId,
      revisedNodeCount: replacedNodeIds.length,
    }),
    reason: reviewComment || revision.reason,
  });
  await createProjectManagementNotificationsTx(tx, {
    actor,
    task: taskAfterPlanSwitch,
    kind: "revision_applied",
    category: "REVISION",
    eventKey: `pm:revision:applied:${revisionNodeId}`,
    title: "计划修订已生效",
    summary: `Task「${task.title}」的 Current Plan 已切换`,
    entityType: "RevisionNode",
    entityId: revisionNodeId,
    mandatory: true,
    recipients: await revisionCreatorAndOwnersTx(
      tx,
      taskAfterPlanSwitch,
      revision,
    ),
  });

  return {
    taskId: task.id,
    revisionNodeId,
    targetPlanVersionId,
    status: "EFFECTIVE",
    currentPlanVersionId: updatedTask.currentPlanVersionId,
    lockVersion: updatedTask.lockVersion,
  };
}

async function assertCreateTaskReferencesTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  input: CreateTaskDraftInput,
) {
  const memberPersonIds = [
    ...new Set(input.members.map((member) => member.personId)),
  ];
  const personCount = await tx.person.count({
    where: {
      id: { in: memberPersonIds },
      OR: [{ status: "ACTIVE" }, { id: actor.personId }],
    },
  });
  if (personCount !== memberPersonIds.length) {
    throw validationError("成员不存在或已停用", {
      members: ["成员不存在或已停用"],
    });
  }
  if (input.tagIds.length > 0) {
    const tagCount = await tx.tag.count({
      where: { id: { in: input.tagIds }, archivedAt: null },
    });
    if (tagCount !== new Set(input.tagIds).size) {
      throw validationError("Tag 不存在或已归档", {
        tagIds: ["Tag 不存在或已归档"],
      });
    }
  }
  if (input.relatedTaskId) {
    const relatedTask = await tx.task.findFirst({
      where: {
        AND: [{ id: input.relatedTaskId }, taskReadableWhere(actor)],
      },
      select: { id: true },
    });
    if (!relatedTask) throw notFoundError();
  }
}

async function createPlanNodesTx(
  tx: PrismaTx,
  {
    taskId,
    planVersionId,
    actorAccountId,
    milestones,
    termination,
    startingSequence,
    carryForward,
  }: {
    taskId: string;
    planVersionId: string;
    actorAccountId: string;
    milestones: CreateTaskDraftInput["milestones"];
    termination: CreateTaskDraftInput["termination"];
    startingSequence: number;
    carryForward: boolean;
  },
) {
  let sequence = startingSequence;
  for (const milestone of milestones) {
    const node = await tx.taskNode.create({
      data: {
        taskId,
        type: "MILESTONE",
        status: "PENDING",
        businessDescription: milestone.businessDescription,
        createdByAccountId: actorAccountId,
        milestone: {
          create: {
            goal: milestone.goal,
            completionCriteria: milestone.completionCriteria,
            expectedCompletedAt: milestone.expectedCompletedAt,
            reviewRequirements: milestone.reviewRequirements,
          },
        },
      },
      select: { id: true },
    });
    await tx.planVersionNode.create({
      data: {
        planVersionId,
        nodeId: node.id,
        sequence,
        isCarryForward: carryForward,
      },
    });
    sequence += 1;
  }

  const terminationNode = await tx.taskNode.create({
    data: {
      taskId,
      type: "TERMINATION",
      status: "PENDING",
      businessDescription: termination.businessDescription,
      createdByAccountId: actorAccountId,
      termination: {
        create: {
          name: termination.name,
          plannedOutcomeCriteria: termination.plannedOutcomeCriteria,
          plannedAt: termination.plannedAt,
        },
      },
    },
    select: { id: true },
  });
  await tx.planVersionNode.create({
    data: {
      planVersionId,
      nodeId: terminationNode.id,
      sequence,
      isCarryForward: carryForward,
    },
  });
}

async function loadTaskForAuthorizationTx(
  tx: PrismaTx,
  taskId: string,
): Promise<TaskForAuthorization> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      team: true,
      techGroup: true,
      status: true,
      priority: true,
      currentPlanVersionId: true,
      activeMilestoneNodeId: true,
      lockVersion: true,
      updatedAt: true,
      deletedAt: true,
      members: {
        where: { removedAt: null },
        select: { personId: true, role: true, removedAt: true },
      },
    },
  });
  if (!task || task.deletedAt) throw notFoundError();
  return task;
}

function taskResource(task: TaskForAuthorization): AuthorizationTaskResource {
  return {
    type: "task",
    id: task.id,
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    priority: task.priority as AuthorizationTaskResource["priority"],
    members: task.members,
  };
}

function assertTaskVisible(actor: ProjectManagementActor, task: TaskForAuthorization) {
  const visible = authorize({
    actor,
    action: "task.view",
    resource: taskResource(task),
  });
  if (!visible.allowed) throw notFoundError();
}

async function refreshActorTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
): Promise<ProjectManagementActor> {
  const roles = await tx.systemRoleAssignment.findMany({
    where: { accountId: actor.accountId, revokedAt: null },
    select: { role: true, team: true, techGroup: true },
  });
  return { ...actor, systemRoles: roles };
}

async function lockIdempotencyKeyTx(
  tx: PrismaTx,
  accountId: string,
  idempotencyKey: string,
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`pm-lifecycle:${accountId}:${idempotencyKey}`}, 0)
    )
  `;
}

async function lockTaskTx(tx: PrismaTx, taskId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
  `;
  if (rows.length === 0) throw notFoundError();
}

async function loadCurrentPlanEntriesTx(tx: PrismaTx, task: TaskForAuthorization) {
  const plan = await tx.taskPlanVersion.findFirst({
    where: {
      id: task.currentPlanVersionId,
      taskId: task.id,
      status: "CURRENT",
    },
    include: {
      nodes: {
        include: planNodeInclude,
        orderBy: { sequence: "asc" },
      },
    },
  });
  if (!plan) throw stateConflictError("当前计划不存在");
  return plan;
}

async function loadPlanEntriesTx(
  tx: PrismaTx,
  planVersionId: string,
): Promise<PlanEntry[]> {
  return tx.planVersionNode.findMany({
    where: { planVersionId },
    include: planNodeInclude,
    orderBy: { sequence: "asc" },
  });
}

async function loadPlanForValidationTx(
  tx: PrismaTx,
  planVersionId: string,
): Promise<{ plannedStartAt: Date | null; nodes: PlanEntry[] }> {
  const plan = await tx.taskPlanVersion.findUnique({
    where: { id: planVersionId },
    select: {
      plannedStartAt: true,
      nodes: {
        include: planNodeInclude,
        orderBy: { sequence: "asc" },
      },
    },
  });
  if (!plan) throw stateConflictError("计划版本不存在");
  return plan;
}

function assertAuthoritativePlanValid(plan: {
  plannedStartAt: Date | null;
  nodes: PlanEntry[];
}) {
  assertPlanChronologyValid(plan, "STRICT");
}

function assertLegacyCurrentPlanUsableAsRepairBase(plan: {
  plannedStartAt: Date | null;
  nodes: PlanEntry[];
}) {
  assertPlanChronologyValid(plan, "LEGACY_CURRENT_BASE");
}

function assertRevisionTargetPlanValid(plan: {
  plannedStartAt: Date | null;
  nodes: PlanEntry[];
}) {
  assertPlanChronologyValid(plan, "STRICT");
}

function assertPlanChronologyValid(
  plan: { plannedStartAt: Date | null; nodes: PlanEntry[] },
  compatibility: PlanChronologyCompatibility,
) {
  const issues = inspectPlanChronology({
    plannedStartAt: plan.plannedStartAt,
    nodes: plan.nodes.map((entry) => ({
      nodeId: entry.nodeId,
      sequence: entry.sequence,
      type: entry.node.type,
      isCarryForward: entry.isCarryForward,
      expectedCompletedAt: entry.node.milestone?.expectedCompletedAt ?? null,
      plannedAt: entry.node.termination?.plannedAt ?? null,
    })),
  }, compatibility);
  if (issues.length > 0) {
    throw planChronologyInvalidError(
      issues[0]?.message ?? "计划时间顺序不正确",
      chronologyFieldErrors(issues),
    );
  }
}

function chronologyFieldErrors(
  issues: PlanChronologyIssue[],
): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    fieldErrors[issue.path] = [
      ...(fieldErrors[issue.path] ?? []),
      issue.message,
    ];
  }
  return fieldErrors;
}

function assertTaskActiveForPlanChange(task: TaskForAuthorization) {
  if (task.status !== "ACTIVE") {
    throw stateConflictError("只有执行中的 Task 可以修订计划");
  }
}

function assertCanManageRevision(
  actor: ProjectManagementActor,
  task: TaskForAuthorization,
  revision: { node: { createdByAccountId: string } },
) {
  assertAuthorized({
    actor,
    action: "revision.create",
    resource: taskResource(task),
  });
  if (revision.node.createdByAccountId === actor.accountId) return;
  assertAuthorized({
    actor,
    action: "task.manage_members",
    resource: taskResource(task),
  });
}

function ensureCreatorOwner(
  members: CreateTaskDraftInput["members"],
  creatorPersonId: string,
): CreateTaskDraftInput["members"] {
  const normalized = new Map(
    members.map((member) => [member.personId, member] as const),
  );
  normalized.set(creatorPersonId, {
    personId: creatorPersonId,
    role: "OWNER",
  });
  return [...normalized.values()];
}

function assertRevisionBaseline(
  task: TaskForAuthorization,
  input: CreateRevisionInput,
) {
  if (input.basePlanVersionId !== task.currentPlanVersionId) {
    throw planVersionConflictError();
  }
  if (input.baseTaskLockVersion !== task.lockVersion) {
    throw planVersionConflictError();
  }
}

async function nextPlanVersionNoTx(tx: PrismaTx, taskId: string): Promise<number> {
  const latest = await tx.taskPlanVersion.findFirst({
    where: { taskId },
    orderBy: { versionNo: "desc" },
    select: { versionNo: true },
  });
  return (latest?.versionNo ?? 0) + 1;
}

function summarizeRevisionCandidate(
  currentEntries: PlanEntry[],
  carriedEntries: PlanEntry[],
  input: CreateRevisionInput,
) {
  return {
    revisionAt: input.revisionAt,
    carriedNodeCount: carriedEntries.length,
    replacedNodeCount: currentEntries.length - carriedEntries.length,
    replacementMilestoneCount: input.replacementMilestones.length,
    terminationName: input.termination.name,
  };
}

function isRevisionCarryForwardEntry(entry: PlanEntry) {
  return (
    (entry.node.type === "MILESTONE" && entry.node.status === "COMPLETED") ||
    (entry.node.type === "REVISION" &&
      entry.node.revision?.status === "EFFECTIVE")
  );
}

async function loadRevisionForMutationTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  revisionNodeId: string,
) {
  const locator = await tx.revisionNode.findUnique({
    where: { id: revisionNodeId },
    select: {
      basePlanVersion: { select: { taskId: true } },
    },
  });
  if (!locator) throw notFoundError();
  await lockTaskTx(tx, locator.basePlanVersion.taskId);
  const revision = await tx.revisionNode.findUnique({
    where: { id: revisionNodeId },
    include: {
      node: true,
      targetPlanVersion: true,
      basePlanVersion: { select: { taskId: true } },
    },
  });
  if (!revision) throw notFoundError();
  const refreshedActor = await refreshActorTx(tx, actor);
  const task = await loadTaskForAuthorizationTx(tx, revision.basePlanVersion.taskId);
  assertTaskVisible(refreshedActor, task);
  return {
    refreshedActor,
    task,
    revision,
    targetPlanVersionId: revision.targetPlanVersion?.id ?? null,
  };
}

async function assertRevisionTargetValidTx(
  tx: PrismaTx,
  task: TaskForAuthorization,
  revision: {
    basePlanVersionId: string;
    baseTaskLockVersion: number;
    revisionAt: Date;
  },
  targetPlanVersionId: string,
) {
  if (revision.basePlanVersionId !== task.currentPlanVersionId) {
    throw planVersionConflictError();
  }
  if (revision.baseTaskLockVersion !== task.lockVersion) {
    throw planVersionConflictError();
  }
  const targetPlan = await loadPlanForValidationTx(tx, targetPlanVersionId);
  assertRevisionTargetPlanValid(targetPlan);
  const basePlan = await loadPlanForValidationTx(
    tx,
    revision.basePlanVersionId,
  );
  assertRevisionStartUnchanged(
    basePlan.plannedStartAt,
    targetPlan.plannedStartAt,
  );
  const terminalAt = targetPlan.nodes.find(
    (entry) => entry.node.type === "TERMINATION",
  )?.node.termination?.plannedAt;
  if (!terminalAt) {
    throw stateConflictError("Revision 候选计划缺少 Terminal");
  }
  await assertRevisionAtValidTx(tx, {
    taskId: task.id,
    revisionAt: revision.revisionAt,
    plannedStartAt: targetPlan.plannedStartAt,
    terminalAt,
    completedMilestoneTimes: targetPlan.nodes.flatMap((entry) =>
      entry.node.milestone && entry.node.status === "COMPLETED"
        ? [entry.node.milestone.expectedCompletedAt]
        : [],
    ),
  });
}

async function assertRevisionAtValidTx(
  tx: PrismaTx,
  input: {
    taskId: string;
    revisionAt: Date;
    plannedStartAt: Date | null;
    terminalAt: Date;
    completedMilestoneTimes: Date[];
  },
) {
  if (!input.plannedStartAt) {
    throw planChronologyInvalidError("计划开始时间不能为空", {
      revisionAt: ["Revision 必须位于有效计划范围内"],
    });
  }
  const fail = (message: string): never => {
    throw planChronologyInvalidError(message, { revisionAt: [message] });
  };
  if (input.revisionAt < input.plannedStartAt) {
    fail("Revision 时间不能早于计划开始时间");
  }
  if (input.revisionAt > input.terminalAt) {
    fail("Revision 时间不能晚于 Terminal");
  }
  const lastCompletedMilestoneAt = input.completedMilestoneTimes.reduce<Date | null>(
    (latest, value) => (!latest || value > latest ? value : latest),
    null,
  );
  if (lastCompletedMilestoneAt && input.revisionAt < lastCompletedMilestoneAt) {
    fail("Revision 时间不能早于最后一个已完成 Milestone");
  }
  const lastEffectiveRevision = await tx.revisionNode.findFirst({
    where: {
      status: "EFFECTIVE",
      node: { taskId: input.taskId },
    },
    orderBy: [{ revisionAt: "desc" }, { id: "desc" }],
    select: { revisionAt: true },
  });
  if (
    lastEffectiveRevision &&
    input.revisionAt < lastEffectiveRevision.revisionAt
  ) {
    fail("Revision 时间不能早于上一条已生效 Revision");
  }
}

function assertRevisionStartUnchanged(
  basePlannedStartAt: Date | null,
  targetPlannedStartAt: Date | null,
) {
  if (
    !basePlannedStartAt ||
    !targetPlannedStartAt ||
    basePlannedStartAt.getTime() !== targetPlannedStartAt.getTime()
  ) {
    throw planVersionConflictError("Revision 不能修改计划开始时间");
  }
}

function assertCompletedPrefixUnchanged(
  baseEntries: PlanEntry[],
  targetEntries: PlanEntry[],
) {
  const completedPrefix = baseEntries.filter(
    (entry) => entry.node.type === "MILESTONE" && entry.node.status === "COMPLETED",
  );
  const targetMilestones = targetEntries.filter(
    (entry) => entry.node.type === "MILESTONE",
  );
  for (const [index, baseEntry] of completedPrefix.entries()) {
    const targetEntry = targetMilestones[index];
    if (!targetEntry || targetEntry.nodeId !== baseEntry.nodeId) {
      throw planVersionConflictError("Revision 不能改变已完成 Milestone");
    }
  }
}

async function activateNextMilestoneInPlanTx(
  tx: PrismaTx,
  entries: PlanEntry[],
): Promise<string | null> {
  const existingActive = entries.find(
    (entry) =>
      entry.node.type === "MILESTONE" && entry.node.status === "ACTIVE",
  );
  if (existingActive) return existingActive.nodeId;

  const nextMilestone = entries.find(
    (entry) =>
      entry.node.type === "MILESTONE" && entry.node.status === "PENDING",
  );
  if (nextMilestone) {
    await tx.taskNode.update({
      where: { id: nextMilestone.nodeId },
      data: { status: "ACTIVE" },
    });
    return nextMilestone.nodeId;
  }

  const termination = entries.find(
    (entry) => entry.node.type === "TERMINATION",
  );
  if (termination && termination.node.status === "PENDING") {
    await tx.taskNode.update({
      where: { id: termination.nodeId },
      data: { status: "ACTIVE" },
    });
  }
  return null;
}

async function advanceCurrentPlanAfterNodeTx(
  tx: PrismaTx,
  task: TaskForAuthorization,
  completedNodeId: string,
): Promise<{ activeMilestoneNodeId: string | null }> {
  const entries = (await loadCurrentPlanEntriesTx(tx, task)).nodes;
  const completedIndex = entries.findIndex(
    (entry) => entry.nodeId === completedNodeId,
  );
  if (completedIndex < 0) {
    throw stateConflictError("当前节点不在 Current Plan 中");
  }
  for (const entry of entries.slice(completedIndex + 1)) {
    if (entry.node.type === "REVISION") {
      if (entry.node.status !== "COMPLETED") {
        await tx.taskNode.update({
          where: { id: entry.nodeId },
          data: { status: "COMPLETED" },
        });
      }
      continue;
    }
    if (entry.node.type === "MILESTONE") {
      if (entry.node.status === "PENDING") {
        await tx.taskNode.update({
          where: { id: entry.nodeId },
          data: { status: "ACTIVE" },
        });
        return { activeMilestoneNodeId: entry.nodeId };
      }
      if (entry.node.status === "ACTIVE") {
        return { activeMilestoneNodeId: entry.nodeId };
      }
      continue;
    }
    if (entry.node.type === "TERMINATION") {
      if (entry.node.status === "PENDING") {
        await tx.taskNode.update({
          where: { id: entry.nodeId },
          data: { status: "ACTIVE" },
        });
      }
      return { activeMilestoneNodeId: null };
    }
  }
  throw stateConflictError("计划缺少结束节点");
}

async function loadMilestoneWithTaskTx(tx: PrismaTx, nodeId: string) {
  const milestone = await tx.milestoneNode.findUnique({
    where: { nodeId },
    include: { node: true },
  });
  if (!milestone || milestone.node.deletedAt) throw notFoundError();
  return milestone;
}

async function loadMilestoneTaskIdTx(
  tx: PrismaTx,
  nodeId: string,
): Promise<string> {
  const milestone = await tx.milestoneNode.findUnique({
    where: { nodeId },
    select: { node: { select: { taskId: true, deletedAt: true } } },
  });
  if (!milestone || milestone.node.deletedAt) throw notFoundError();
  return milestone.node.taskId;
}

async function loadMilestoneReviewForMutationTx(tx: PrismaTx, reviewId: string) {
  const review = await tx.milestoneReview.findUnique({
    where: { id: reviewId },
    include: {
      milestoneNode: {
        include: {
          node: true,
        },
      },
    },
  });
  if (!review || review.milestoneNode.node.deletedAt) throw notFoundError();
  return review;
}

async function loadMilestoneReviewTaskIdTx(
  tx: PrismaTx,
  reviewId: string,
): Promise<string> {
  const review = await tx.milestoneReview.findUnique({
    where: { id: reviewId },
    select: {
      milestoneNode: {
        select: {
          node: { select: { taskId: true, deletedAt: true } },
        },
      },
    },
  });
  if (!review || review.milestoneNode.node.deletedAt) throw notFoundError();
  return review.milestoneNode.node.taskId;
}

async function loadTerminationWithNodeTx(tx: PrismaTx, nodeId: string) {
  const termination = await tx.terminationNode.findUnique({
    where: { nodeId },
    include: { node: true },
  });
  if (!termination || termination.node.deletedAt) throw notFoundError();
  return termination;
}

async function assertNodeInCurrentPlanTx(
  tx: PrismaTx,
  task: TaskForAuthorization,
  nodeId: string,
  type: TaskNodeType,
) {
  const exists = await tx.planVersionNode.findFirst({
    where: {
      planVersionId: task.currentPlanVersionId,
      nodeId,
      node: { type },
    },
    select: { id: true },
  });
  if (!exists) throw stateConflictError("节点不属于 Current Plan");
}

function outcomeToTaskStatus(outcome: TerminationOutcome): TaskStatus {
  if (outcome === "SUCCESS") return "COMPLETED";
  if (outcome === "FAILED") return "FAILED";
  if (outcome === "CANCELLED") return "CANCELLED";
  return "TIMEOUT";
}

async function notifyTaskMembersTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    task: TaskForAuthorization;
    kind: ProjectManagementNotificationPayload["kind"];
    category: ProjectManagementNotificationCategory;
    eventKey: string;
    title: string;
    summary: string;
    entityType: string;
    entityId: string;
    mandatory: boolean;
  },
) {
  const recipients = await taskMemberRecipientsTx(tx, input.task.id);
  await createProjectManagementNotificationsTx(tx, { ...input, recipients });
}

async function notifyGlobalAdministratorsTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    task: TaskForAuthorization;
    kind: "milestone_review_submitted" | "revision_pending_review";
    category: ProjectManagementNotificationCategory;
    eventKey: string;
    title: string;
    summary: string;
    entityType: string;
    entityId: string;
    mandatory: boolean;
  },
) {
  const recipients = await globalAdministratorRecipientsTx(tx);
  await createProjectManagementNotificationsTx(tx, { ...input, recipients });
}

async function notifyRevisionResultTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    task: TaskForAuthorization;
    revisionNodeId: string;
    title: string;
    summary: string;
    eventKey: string;
    recipients: NotificationRecipient[];
  },
) {
  await createProjectManagementNotificationsTx(tx, {
    actor: input.actor,
    task: input.task,
    kind: "revision_result",
    category: "REVISION",
    eventKey: input.eventKey,
    title: input.title,
    summary: input.summary,
    entityType: "RevisionNode",
    entityId: input.revisionNodeId,
    mandatory: true,
    recipients: input.recipients,
  });
}

async function notifyMilestoneReviewResultTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    task: TaskForAuthorization;
    reviewId: string;
    result: MilestoneReviewResult;
    summary: string;
    recipients: NotificationRecipient[];
  },
) {
  await createProjectManagementNotificationsTx(tx, {
    actor: input.actor,
    task: input.task,
    kind: "milestone_review_result",
    category: "REVIEW",
    eventKey: `pm:milestone:review_result:${input.reviewId}:${input.result}`,
    title: "Milestone 验收结果已更新",
    summary: input.summary,
    entityType: "MilestoneReview",
    entityId: input.reviewId,
    mandatory: true,
    recipients: input.recipients,
  });
}

async function createProjectManagementNotificationsTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    task: TaskForAuthorization;
    kind: ProjectManagementNotificationPayload["kind"];
    category: ProjectManagementNotificationCategory;
    eventKey: string;
    title: string;
    summary: string;
    entityType: string;
    entityId: string;
    mandatory: boolean;
    recipients: NotificationRecipient[];
  },
) {
  await createProjectManagementEventNotificationsTx(tx, {
    actor: input.actor,
    task: {
      id: input.task.id,
      title: input.task.title,
      status: input.task.status,
      currentPlanVersionId: input.task.currentPlanVersionId,
    },
    kind: input.kind,
    category: input.category,
    eventKey: input.eventKey,
    title: input.title,
    summary: input.summary,
    entityType: input.entityType,
    entityId: input.entityId,
    linkPath: PROGRESS_LINK,
    mandatory: input.mandatory,
    recipients: input.recipients,
  });
}

async function taskMemberRecipientsTx(
  tx: PrismaTx,
  taskId: string,
): Promise<NotificationRecipient[]> {
  const members = await tx.taskMember.findMany({
    where: {
      taskId,
      removedAt: null,
      role: { in: ["OWNER", "PARTICIPANT"] },
    },
    select: {
      person: {
        select: {
          account: {
            select: {
              id: true,
              identities: {
                where: {
                  provider: FEISHU_PROVIDER,
                  tenantId: DEFAULT_TENANT_ID,
                },
                select: { id: true, openId: true },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              },
            },
          },
        },
      },
    },
  });
  return members
    .map((member) => member.person.account)
    .filter((account): account is NonNullable<typeof account> => Boolean(account))
    .map((account) => ({
      accountId: account.id,
      openId: firstNonEmptyOpenId(account.identities),
    }));
}

async function globalAdministratorRecipientsTx(
  tx: PrismaTx,
): Promise<NotificationRecipient[]> {
  await lockGlobalApprovalAdministratorSetTx(tx);
  const accountIds = await activeGlobalApprovalAdministratorAccountIdsTx(tx);
  if (accountIds.length === 0) {
    throw stateConflictError(ACTIVE_GLOBAL_APPROVAL_ADMINISTRATOR_REQUIRED);
  }
  const globalAdministrators = await tx.account.findMany({
    where: { id: { in: accountIds } },
    select: {
      id: true,
      identities: {
        where: {
          provider: FEISHU_PROVIDER,
          tenantId: DEFAULT_TENANT_ID,
        },
        select: { id: true, openId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
    orderBy: { id: "asc" },
  });
  const recipients = globalAdministrators.map((account) => ({
      accountId: account.id,
      openId: firstNonEmptyOpenId(account.identities),
  }));
  if (!recipients.some((recipient) => recipient.openId)) {
    throw stateConflictError(
      "当前没有具备有效飞书身份的活跃全局管理员，无法提交审批",
    );
  }
  return recipients;
}

async function revisionCreatorAndOwnersTx(
  tx: PrismaTx,
  task: TaskForAuthorization,
  revision: { node: { createdByAccountId: string } },
): Promise<NotificationRecipient[]> {
  const ownerPersonIds = task.members
    .filter((member) => member.role === "OWNER")
    .map((member) => member.personId);
  return accountRecipientsTx(tx, {
    accountIds: [revision.node.createdByAccountId],
    personIds: ownerPersonIds,
  });
}

async function reviewSubmitterAndOwnersTx(
  tx: PrismaTx,
  task: TaskForAuthorization,
  review: { submittedByAccountId: string | null },
): Promise<NotificationRecipient[]> {
  const ownerPersonIds = task.members
    .filter((member) => member.role === "OWNER")
    .map((member) => member.personId);
  return accountRecipientsTx(tx, {
    accountIds: review.submittedByAccountId ? [review.submittedByAccountId] : [],
    personIds: ownerPersonIds,
  });
}

async function accountRecipientsTx(
  tx: PrismaTx,
  input: { accountIds: string[]; personIds: string[] },
): Promise<NotificationRecipient[]> {
  if (input.accountIds.length === 0 && input.personIds.length === 0) {
    return [];
  }
  const accounts = await tx.account.findMany({
    where: {
      OR: [
        ...(input.accountIds.length > 0
          ? [{ id: { in: input.accountIds } }]
          : []),
        ...(input.personIds.length > 0
          ? [{ person: { id: { in: input.personIds } } }]
          : []),
      ],
    },
    select: {
      id: true,
      identities: {
        where: {
          provider: FEISHU_PROVIDER,
          tenantId: DEFAULT_TENANT_ID,
        },
        select: { id: true, openId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  return accounts.map((account) => ({
    accountId: account.id,
    openId: firstNonEmptyOpenId(account.identities),
  }));
}

function firstNonEmptyOpenId(
  identities: Array<{ openId: string | null }>,
): string | null {
  return identities
    .map((identity) => identity.openId?.trim() ?? "")
    .find(Boolean) ?? null;
}

function hashRequest(operation: string, input: unknown): string {
  return createHash("sha256")
    .update(stableStringify({ operation, input }))
    .digest("hex");
}

function hashPlan(plan: {
  plannedStartAt: Date | null;
  nodes: PlanEntry[];
}): string {
  return hashPlanSnapshot({
    plannedStartAt: plan.plannedStartAt?.toISOString() ?? null,
    nodes: plan.nodes.map((entry) => ({
      sequence: entry.sequence,
      nodeId: entry.nodeId,
      type: entry.node.type,
      businessDescription: entry.node.businessDescription,
      milestone: entry.node.milestone
        ? {
            goal: entry.node.milestone.goal,
            completionCriteria: entry.node.milestone.completionCriteria,
            expectedCompletedAt:
              entry.node.milestone.expectedCompletedAt.toISOString(),
            reviewRequirements: entry.node.milestone.reviewRequirements,
          }
        : null,
      revision: entry.node.revision
        ? {
            reason: entry.node.revision.reason,
            revisionAt: entry.node.revision.revisionAt.toISOString(),
            reviewRound: entry.node.revision.reviewRound,
            basePlanVersionId: entry.node.revision.basePlanVersionId,
          }
        : null,
      termination: entry.node.termination
        ? {
            ...(entry.node.termination.name !== "Terminal"
              ? { name: entry.node.termination.name }
              : {}),
            plannedOutcomeCriteria:
              entry.node.termination.plannedOutcomeCriteria,
            plannedAt: entry.node.termination.plannedAt.toISOString(),
          }
        : null,
    })),
  });
}

function revisionPlanAuditState(plan: {
  plannedStartAt: Date | null;
  nodes: PlanEntry[];
}) {
  return {
    plannedStartAt: plan.plannedStartAt?.toISOString() ?? null,
    snapshotHash: hashPlan(plan),
    nodeCount: plan.nodes.length,
    nodeOrder: plan.nodes.slice(0, 202).map((entry) => ({
      nodeId: entry.nodeId,
      sequence: entry.sequence,
      type: entry.node.type,
    })),
  };
}

function summarizeRevisionPlanChanges(
  before: { plannedStartAt: Date | null; nodes: PlanEntry[] },
  after: { plannedStartAt: Date | null; nodes: PlanEntry[] },
) {
  const beforeById = new Map(before.nodes.map((entry) => [entry.nodeId, entry]));
  const afterById = new Map(after.nodes.map((entry) => [entry.nodeId, entry]));
  const removedEntries = before.nodes.filter(
    (entry) => !afterById.has(entry.nodeId),
  );
  const addedEntries = after.nodes.filter(
    (entry) => !beforeById.has(entry.nodeId),
  );
  const changedEntries = after.nodes.flatMap((entry) => {
    const previous = beforeById.get(entry.nodeId);
    if (!previous) return [];
    const previousView = revisionNodeAuditView(previous);
    const nextView = revisionNodeAuditView(entry);
    if (stableStringify(previousView) === stableStringify(nextView)) return [];
    return [{ nodeId: entry.nodeId, before: previousView, after: nextView }];
  });
  const removed = removedEntries
    .slice(0, 50)
    .map(revisionNodeAuditView);
  const added = addedEntries
    .slice(0, 50)
    .map(revisionNodeAuditView);
  const changed = changedEntries.slice(0, 50);
  return {
    plannedStartAtChanged:
      before.plannedStartAt?.toISOString() !== after.plannedStartAt?.toISOString(),
    removedTotal: removedEntries.length,
    addedTotal: addedEntries.length,
    changedTotal: changedEntries.length,
    removed,
    added,
    changed,
    truncated:
      removedEntries.length > removed.length ||
      addedEntries.length > added.length ||
      changedEntries.length > changed.length,
  };
}

function revisionNodeAuditView(entry: PlanEntry) {
  return {
    nodeId: entry.nodeId,
    sequence: entry.sequence,
    type: entry.node.type,
    businessDescription: boundedAuditText(entry.node.businessDescription),
    milestone: entry.node.milestone
      ? {
          goal: boundedAuditText(entry.node.milestone.goal),
          completionCriteria: boundedAuditText(
            entry.node.milestone.completionCriteria,
          ),
          expectedCompletedAt:
            entry.node.milestone.expectedCompletedAt.toISOString(),
          reviewRequirements: boundedAuditText(
            entry.node.milestone.reviewRequirements,
          ),
        }
      : null,
    termination: entry.node.termination
      ? {
          name: boundedAuditText(entry.node.termination.name),
          plannedAt: entry.node.termination.plannedAt.toISOString(),
          plannedOutcomeCriteria: boundedAuditText(
            entry.node.termination.plannedOutcomeCriteria,
          ),
        }
      : null,
  };
}

function boundedAuditText(value: string) {
  return value.length <= 160 ? value : `${value.slice(0, 160)}…`;
}

function stableStringify(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) =>
        `${JSON.stringify(key)}:${stableStringify(
          (value as Record<string, unknown>)[key],
        )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
