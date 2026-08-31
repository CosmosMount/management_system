import { randomUUID } from "node:crypto";
import type { TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertAuthorized } from "@/lib/project-management/authorization";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import {
  staleTaskError,
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import {
  acquireProjectCrossAggregateLockTx,
  assertActiveProjectTargetTx,
  recordTaskProjectChangeTx,
  syncTaskMembersToProjectTx,
} from "@/lib/project-management/application/project-service";
import {
  assertAuthoritativePlanValid,
  assertCreateTaskReferencesTx,
  assertTaskVisible,
  createPlanNodesTx,
  loadCurrentPlanEntriesTx,
  loadPlanForValidationTx,
  loadTaskForAuthorizationTx,
  lockIdempotencyKeyTx,
  lockTaskTx,
} from "@/lib/project-management/application/lifecycle-domain";
import {
  hashLifecyclePlan,
  hashLifecycleRequest,
} from "@/lib/project-management/application/lifecycle-plan-audit";
import { notifyTaskMembersTx } from "@/lib/project-management/application/lifecycle-notifications";
import { taskAuthorizationResource } from "@/lib/project-management/application/task-authorization-resource";
import { jsonValue } from "@/lib/project-management/application/prisma-json";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  activateTaskInputSchema,
  createTaskDraftInputSchema,
  deleteTaskDraftInputSchema,
  type CreateTaskDraftInput,
} from "@/lib/project-management/validations/lifecycle";

type LifecycleTaskResult = {
  taskId: string;
  currentPlanVersionId: string;
  status: TaskStatus;
  lockVersion: number;
  activeMilestoneNodeId: string | null;
};

export type CreateTaskDraftResult = LifecycleTaskResult & { created: boolean };

export type DeleteTaskDraftResult = {
  taskId: string;
  lockVersion: number;
  deletedAt: string;
};

function terminationDisplayName(name: string | null | undefined) {
  return !name || name === "Terminal" ? "结束节点" : name;
}

export async function createTaskDraft(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<CreateTaskDraftResult> {
  assertCurrentTaskComposerPayloadVersion(input);
  const parsed = createTaskDraftInputSchema.parse(input);
  const requestHash = `v2:${hashLifecycleRequest("task.create_draft", parsed)}`;
  const legacyRequestHash = legacyCreateTaskDraftRequestHash(
    parsed,
    actor.personId,
  );

  return prisma.$transaction(async (tx) => {
    await acquireProjectCrossAggregateLockTx(tx);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
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
      if (
        existing.creationRequestHash !== requestHash &&
        (existing.creationRequestHash.startsWith("v2:") ||
          existing.creationRequestHash !== legacyRequestHash)
      ) {
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

    await assertCreateTaskReferencesTx(tx, refreshedActor, parsed);
    await assertActiveProjectTargetTx(tx, parsed.projectId);
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
        projectId: parsed.projectId,
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
      data: { snapshotHash: hashLifecyclePlan(initialPlan) },
    });
    if (parsed.members.length > 0) {
      await tx.taskMember.createMany({
        data: parsed.members.map((member) => ({
          taskId,
          personId: member.personId,
          role: member.role,
          createdByAccountId: refreshedActor.accountId,
        })),
      });
    }
    await syncTaskMembersToProjectTx(tx, {
      projectId: parsed.projectId,
      taskId,
      members: parsed.members,
      actor: refreshedActor,
    });
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
        projectId: parsed.projectId,
        milestoneCount: parsed.milestones.length,
        terminationName: parsed.termination.name,
        memberCount: parsed.members.length,
      }),
      reason: "创建 Task 草稿",
    });
    if (parsed.projectId) {
      await recordTaskProjectChangeTx(tx, refreshedActor, {
        id: taskId,
        title: parsed.title,
        status: "DRAFT",
        members: parsed.members.map((member) => ({
          ...member,
          removedAt: null,
        })),
        beforeProjectId: null,
        afterProjectId: parsed.projectId,
        lockVersion: 0,
      });
    }

    if (parsed.members.length > 0) {
      const task = await loadTaskForAuthorizationTx(tx, taskId);
      await notifyTaskMembersTx(tx, {
        actor: refreshedActor,
        task,
        kind: "task_assigned",
        category: "TASK",
        eventKey: `pm:task:assigned:${taskId}:v1`,
        title: "你已被加入任务",
        summary: `任务「${task.title}」已创建为草稿`,
        entityType: "Task",
        entityId: taskId,
        mandatory: true,
      });
    }

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

function legacyCreateTaskDraftRequestHash(
  input: CreateTaskDraftInput,
  creatorPersonId: string,
): string {
  // 兼容重构前已落库的幂等请求：旧实现会先把创建者覆盖为 OWNER 再计算 hash。
  const membersByPersonId = new Map(
    input.members.map((member) => [member.personId, member] as const),
  );
  membersByPersonId.set(creatorPersonId, {
    personId: creatorPersonId,
    role: "OWNER",
  });
  return hashLifecycleRequest("task.create_draft", {
    ...input,
    members: [...membersByPersonId.values()],
  });
}

export async function activateTask(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<LifecycleTaskResult> {
  const parsed = activateTaskInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    await lockTaskTx(tx, parsed.taskId);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, parsed.taskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "task.activate",
      resource: taskAuthorizationResource(task),
    });
    if (task.status !== "DRAFT") {
      throw stateConflictError("只有草稿 Task 可以激活");
    }
    if (task.lockVersion !== parsed.expectedLockVersion) {
      throw staleTaskError(task);
    }

    const currentPlan = await loadCurrentPlanEntriesTx(tx, task);
    assertAuthoritativePlanValid(currentPlan);
    const now = new Date();
    if (!currentPlan.plannedStartAt) {
      throw stateConflictError("计划缺少开始时间，不能激活 Task");
    }
    if (currentPlan.plannedStartAt.getTime() > now.getTime()) {
      throw stateConflictError("计划开始时间尚未到达，不能激活 Task");
    }
    const activeOwnerCount = await tx.taskMember.count({
      where: {
        taskId: task.id,
        removedAt: null,
        role: "OWNER",
        person: { status: "ACTIVE" },
      },
    });
    if (activeOwnerCount === 0) {
      throw validationError("激活 Task 前至少需要一名有效负责人", {
        members: ["激活 Task 前至少需要一名有效负责人"],
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
        snapshotHash: hashLifecyclePlan(currentPlan),
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
        activeNodeName:
          firstActiveNode.node.termination?.name ??
          firstActiveNode.node.milestone?.goal ??
          null,
      }),
      reason: "激活 Task",
    });
    await notifyTaskMembersTx(tx, {
      actor: refreshedActor,
      task: { ...task, status: updated.status },
      kind: "task_activated",
      category: "TASK",
      eventKey: `pm:task:activated:${task.id}:${updated.lockVersion}`,
      title: "任务已开始执行",
      summary: firstMilestone
        ? `任务「${task.title}」已开始执行`
        : `任务「${task.title}」已开始执行，当前节点：${terminationDisplayName(termination?.node.termination?.name)}`,
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

export async function deleteTaskDraft(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<DeleteTaskDraftResult> {
  const parsed = deleteTaskDraftInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await lockTaskTx(tx, parsed.taskId);
    const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
    const task = await loadTaskForAuthorizationTx(tx, parsed.taskId);
    assertTaskVisible(refreshedActor, task);
    assertAuthorized({
      actor: refreshedActor,
      action: "task.delete",
      resource: taskAuthorizationResource(task),
    });
    if (task.status !== "DRAFT") {
      throw stateConflictError("只有未激活的草稿 Task 可以删除");
    }
    if (task.lockVersion !== parsed.expectedLockVersion) {
      throw staleTaskError(task);
    }

    const deletedAt = new Date();
    const updated = await tx.task.update({
      where: { id: task.id },
      data: { deletedAt, lockVersion: { increment: 1 } },
      select: { lockVersion: true },
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.task.draft.delete",
      entityType: "Task",
      entityId: task.id,
      taskId: task.id,
      before: jsonValue({
        status: task.status,
        deletedAt: null,
        lockVersion: task.lockVersion,
      }),
      after: jsonValue({
        status: task.status,
        deletedAt: deletedAt.toISOString(),
        lockVersion: updated.lockVersion,
      }),
      reason: "删除未激活的 Task 草稿",
    });
    await notifyTaskMembersTx(tx, {
      actor: refreshedActor,
      task,
      kind: "task_deleted",
      category: "TASK",
      eventKey: `pm:task:deleted:${task.id}:${updated.lockVersion}`,
      title: "任务草稿已删除",
      summary: `任务草稿「${task.title}」已删除`,
      entityType: "Task",
      entityId: task.id,
      mandatory: true,
    });
    return {
      taskId: task.id,
      lockVersion: updated.lockVersion,
      deletedAt: deletedAt.toISOString(),
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
