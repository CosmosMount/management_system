import { createHash } from "node:crypto";
import type {
  Prisma,
  TaskMemberRole,
  TaskNodeType,
  TaskStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  assertAuthorized,
  authorize,
  taskReadableWhere,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  associationInvalidError,
  notFoundError,
  staleTaskError,
  stateConflictError,
  validationError,
} from "@/lib/project-management/application/errors";
import {
  createProjectManagementEventNotificationsTx,
  recipientsForPersonIdsTx,
} from "@/lib/project-management/application/notification-utils";
import { hashPlanSnapshot } from "@/lib/project-management/application/plan-snapshot";
import { lockTaskSegmentAssociationsTx } from "@/lib/project-management/application/task-segment-association-lock";
import { assertPersistedPlanChronologyValid } from "@/lib/project-management/application/persisted-plan-chronology";
import { taskMemberRoleLabels } from "@/lib/project-management/labels";
import {
  replaceTaskDraftMembersInputSchema,
  replaceTaskDraftPlanInputSchema,
  replaceTaskMembersInputSchema,
  updateActiveTaskInputSchema,
  updateTaskDraftInputSchema,
  updateTaskDraftMetadataInputSchema,
  updateTaskMetadataInputSchema,
  type ReplaceTaskDraftMembersInput,
  type ReplaceTaskDraftPlanInput,
  type ReplaceTaskMembersInput,
  type UpdateTaskDraftMetadataInput,
  type UpdateTaskMetadataInput,
} from "@/lib/project-management/validations/task-mutations";
import { refreshProjectManagementActorTx } from "@/lib/project-management/application/actor-refresh";
import { acquireProjectCrossAggregateLockTx, assertTaskProjectChangeAllowedTx, syncTaskMembersToProjectTx } from "@/lib/project-management/application/project-service";

type PrismaTx = Prisma.TransactionClient;

const PROGRESS_LINK = "/progress";
const DEFAULT_FEISHU_TENANT_ID = "default";
const PLAN_AUDIT_NODE_DETAIL_LIMIT = 201;

const taskMutationInclude = {
  members: {
    where: { removedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.TaskInclude;

type TaskForMutation = Prisma.TaskGetPayload<{
  include: typeof taskMutationInclude;
}>;

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

type PlanForMutation = Prisma.TaskPlanVersionGetPayload<{
  include: {
    nodes: {
      include: typeof planNodeInclude;
      orderBy: { sequence: "asc" };
    };
  };
}>;

export type TaskMutationResult = {
  taskId: string;
  status: TaskStatus;
  currentPlanVersionId: string;
  lockVersion: number;
  updatedAt: string;
};

export type TaskMetadataMutationResult = TaskMutationResult;

export type TaskMembersMutationResult = TaskMutationResult & {
  members: Array<{ personId: string; role: TaskMemberRole }>;
};

export type ActiveTaskUpdateMutationResult = TaskMutationResult & {
  members: Array<{ personId: string; role: TaskMemberRole }>;
};

export type TaskDraftPlanMutationResult = TaskMutationResult & {
  planVersionId: string;
  plannedStartAt: string;
  snapshotHash: string;
  nodeMappings: Array<{ clientKey: string; nodeId: string }>;
  nodes: Array<{
    nodeId: string;
    sequence: number;
    type: TaskNodeType;
  }>;
};

export type TaskDraftUpdateMutationResult = TaskDraftPlanMutationResult & {
  members: Array<{ personId: string; role: TaskMemberRole }>;
};

export async function updateTaskDraft(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<TaskDraftUpdateMutationResult> {
  const parsed = updateTaskDraftInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task } = await loadLockedTaskTx(
      tx,
      actor,
      parsed.taskId,
    );
    assertAuthorizedTaskAction(refreshedActor, task, "task.update_metadata");
    assertTaskStatus(task, "DRAFT");
    assertExpectedLockVersion(task, parsed.expectedLockVersion);
    assertAuthorizedTargetScope(refreshedActor, task, parsed);
    await assertRelatedTaskVisibleTx(
      tx,
      refreshedActor,
      task.id,
      parsed.relatedTaskId,
      task.relatedTaskId,
    );
    const targetProjectId = parsed.projectId === undefined ? task.projectId : parsed.projectId;
    await assertTaskProjectChangeAllowedTx(tx, task.projectId, targetProjectId);

    if (parsed.members) {
      assertAuthorizedTaskAction(refreshedActor, task, "task.manage_members");
      assertExistingMemberInvariant(task.members);
      assertRequestedMemberInvariant(parsed.members);
      await assertActivePeopleTx(
        tx,
        parsed.members.map((member) => member.personId),
        task.members.map((member) => member.personId),
      );
      await assertTaskSegmentMembersIncludedTx(tx, task.id, parsed.members);
    }

    const plan = await loadInitialDraftPlanTx(
      tx,
      task,
      parsed.planVersionId,
    );
    const replacement = await resolveDraftPlanReplacementTx(tx, plan, parsed);
    const beforePlan = auditPlanState(plan);
    const beforeMetadata = metadataSnapshot(task);
    const beforeMembers = memberSnapshot(task.members);

    await tx.task.update({
      where: { id: task.id },
      data: {
        title: parsed.title,
        description: parsed.description,
        team: parsed.team,
        techGroup: parsed.techGroup,
        priority: parsed.priority,
        relatedTaskId: parsed.relatedTaskId,
        projectId: parsed.projectId,
      },
    });
    if (parsed.members) {
      await applyMemberChangesTx(tx, {
        taskId: task.id,
        actorAccountId: refreshedActor.accountId,
        currentMembers: task.members,
        requestedMembers: parsed.members,
      });
    }
    await syncTaskMembersToProjectTx(tx, { projectId: targetProjectId, taskId: task.id, members: parsed.members ?? task.members, actor: refreshedActor });

    await tx.planVersionNode.deleteMany({
      where: { planVersionId: plan.id },
    });
    await deleteOmittedDraftNodesTx(tx, replacement.omittedEntries);
    await persistReplacementNodesTx(tx, {
      task,
      actorAccountId: refreshedActor.accountId,
      milestones: replacement.milestones,
      termination: replacement.termination,
    });
    await tx.planVersionNode.createMany({
      data: [
        ...replacement.milestones.map((milestone, index) => ({
          planVersionId: plan.id,
          nodeId: milestone.nodeId,
          sequence: index + 1,
          isCarryForward: false,
        })),
        {
          planVersionId: plan.id,
          nodeId: replacement.termination.nodeId,
          sequence: replacement.milestones.length + 1,
          isCarryForward: false,
        },
      ],
    });
    await tx.taskPlanVersion.update({
      where: { id: plan.id },
      data: { plannedStartAt: parsed.plannedStartAt },
    });

    const authoritativePlan = await loadPlanForMutationTx(tx, plan.id);
    assertAuthoritativePlanValid(authoritativePlan);
    const snapshotHash = hashPlan(authoritativePlan);
    await tx.taskPlanVersion.update({
      where: { id: plan.id },
      data: { snapshotHash },
    });
    const updatedTask = await incrementTaskLockTx(
      tx,
      task,
      parsed.expectedLockVersion,
    );
    const afterMembers = memberSnapshot(parsed.members ?? task.members);
    const afterPlan = auditPlanState({
      ...authoritativePlan,
      snapshotHash,
    });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.task.draft.update",
      entityType: "Task",
      entityId: task.id,
      taskId: task.id,
      before: jsonValue({
        metadata: beforeMetadata,
        members: beforeMembers,
        plan: beforePlan,
        lockVersion: task.lockVersion,
      }),
      after: jsonValue({
        metadata: metadataSnapshot(updatedTask),
        members: afterMembers,
        plan: afterPlan,
        planChanges: summarizePlanChanges(plan, authoritativePlan),
        lockVersion: updatedTask.lockVersion,
      }),
      reason: "统一更新 Task 草稿",
    });
    await auditTaskProjectChangeTx(tx, refreshedActor, task, updatedTask);

    return {
      ...serializeTaskMutation(updatedTask),
      members: afterMembers,
      planVersionId: plan.id,
      plannedStartAt: parsed.plannedStartAt.toISOString(),
      snapshotHash,
      nodeMappings: replacement.nodeMappings,
      nodes: authoritativePlan.nodes.map((entry) => ({
        nodeId: entry.nodeId,
        sequence: entry.sequence,
        type: entry.node.type,
      })),
    };
  });
}

export async function updateTaskDraftMetadata(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<TaskMetadataMutationResult> {
  const parsed = updateTaskDraftMetadataInputSchema.parse(input);
  return updateTaskMetadataForStatus(actor, parsed, "DRAFT");
}

export async function updateTaskMetadata(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<TaskMetadataMutationResult> {
  const parsed = updateTaskMetadataInputSchema.parse(input);
  return updateTaskMetadataForStatus(actor, parsed, "ACTIVE");
}

export async function updateActiveTask(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<ActiveTaskUpdateMutationResult> {
  const parsed = updateActiveTaskInputSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task } = await loadLockedTaskTx(
      tx,
      actor,
      parsed.taskId,
    );
    assertTaskStatus(task, "ACTIVE");
    assertExpectedLockVersion(task, parsed.expectedLockVersion);

    if (parsed.metadata) {
      assertAuthorizedTaskAction(refreshedActor, task, "task.update_metadata");
    }
    if (parsed.metadata) {
      assertAuthorizedTargetScope(refreshedActor, task, parsed.metadata);
      await assertRelatedTaskVisibleTx(
        tx,
        refreshedActor,
        task.id,
        parsed.metadata.relatedTaskId,
        task.relatedTaskId,
      );
      const targetProjectId = parsed.metadata.projectId === undefined ? task.projectId : parsed.metadata.projectId;
      await assertTaskProjectChangeAllowedTx(tx, task.projectId, targetProjectId);
    }

    let memberChanges: MemberChange[] = [];
    if (parsed.members) {
      assertAuthorizedTaskAction(refreshedActor, task, "task.manage_members");
      assertExistingMemberInvariant(task.members);
      assertRequestedMemberInvariant(parsed.members);
      await assertActivePeopleTx(
        tx,
        parsed.members.map((member) => member.personId),
        task.members.map((member) => member.personId),
      );
      await assertTaskSegmentMembersIncludedTx(tx, task.id, parsed.members);
      memberChanges = calculateMemberChanges(task.members, parsed.members);
    }

    const beforeMetadata = metadataSnapshot(task);
    const beforeMembers = memberSnapshot(task.members);
    const afterMembers = parsed.members
      ? memberSnapshot(parsed.members)
      : beforeMembers;
    const metadataChanged = parsed.metadata
      ? !taskMetadataMatches(task, parsed.metadata)
      : false;
    const membersChanged = parsed.members
      ? !sameStringArray(
          beforeMembers.map(memberKey),
          afterMembers.map(memberKey),
        )
      : false;
    if (metadataChanged && parsed.metadata) {
      await tx.task.update({
        where: { id: task.id },
        data: parsed.metadata,
      });
    }
    if (membersChanged && parsed.members) {
      await applyMemberChangesTx(tx, {
        taskId: task.id,
        actorAccountId: refreshedActor.accountId,
        currentMembers: task.members,
        requestedMembers: parsed.members,
      });
    }
    if (metadataChanged || membersChanged) {
      await syncTaskMembersToProjectTx(tx, { projectId: parsed.metadata?.projectId === undefined ? task.projectId : parsed.metadata.projectId, taskId: task.id, members: parsed.members ?? task.members, actor: refreshedActor });
    }

    const updatedTask = metadataChanged || membersChanged
      ? await incrementTaskLockTx(tx, task, parsed.expectedLockVersion)
      : task;

    if (metadataChanged) {
      await createDomainAuditEventTx(tx, {
        actorAccountId: refreshedActor.accountId,
        actorPersonId: refreshedActor.personId,
        action: "pm.task.metadata.update",
        entityType: "Task",
        entityId: task.id,
        taskId: task.id,
        before: jsonValue({
          ...beforeMetadata,
          lockVersion: task.lockVersion,
        }),
        after: jsonValue({
          ...metadataSnapshot(updatedTask),
          lockVersion: updatedTask.lockVersion,
        }),
        reason: "更新 Task 元数据",
      });
      await auditTaskProjectChangeTx(tx, refreshedActor, task, updatedTask);
    }
    if (membersChanged) {
      await createDomainAuditEventTx(tx, {
        actorAccountId: refreshedActor.accountId,
        actorPersonId: refreshedActor.personId,
        action: "pm.task.members.replace",
        entityType: "Task",
        entityId: task.id,
        taskId: task.id,
        before: jsonValue({ members: beforeMembers, lockVersion: task.lockVersion }),
        after: jsonValue({ members: afterMembers, lockVersion: updatedTask.lockVersion }),
        reason: "更新 Active Task 成员",
      });
    }
    if (membersChanged && memberChanges.length > 0) {
      await notifyActiveMemberChangesTx(tx, {
        actor: refreshedActor,
        task: updatedTask,
        lockVersion: updatedTask.lockVersion,
        changes: memberChanges,
      });
    }

    return {
      ...serializeTaskMutation(updatedTask),
      members: afterMembers,
    };
  });
}

export async function replaceTaskDraftMembers(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<TaskMembersMutationResult> {
  const parsed = replaceTaskDraftMembersInputSchema.parse(input);
  return replaceTaskMembersForStatus(actor, parsed, "DRAFT");
}

export async function replaceTaskMembers(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<TaskMembersMutationResult> {
  const parsed = replaceTaskMembersInputSchema.parse(input);
  return replaceTaskMembersForStatus(actor, parsed, "ACTIVE");
}

export async function replaceTaskDraftPlan(
  actor: ProjectManagementActor,
  input: unknown,
): Promise<TaskDraftPlanMutationResult> {
  const parsed = replaceTaskDraftPlanInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task } = await loadLockedTaskTx(
      tx,
      actor,
      parsed.taskId,
    );
    assertAuthorizedTaskAction(refreshedActor, task, "task.update_metadata");
    assertTaskStatus(task, "DRAFT");
    assertExpectedLockVersion(task, parsed.expectedLockVersion);

    const plan = await loadInitialDraftPlanTx(tx, task, parsed.planVersionId);
    const replacement = await resolveDraftPlanReplacementTx(tx, plan, parsed);
    const beforePlan = auditPlanState(plan);

    await tx.planVersionNode.deleteMany({
      where: { planVersionId: plan.id },
    });
    await deleteOmittedDraftNodesTx(tx, replacement.omittedEntries);
    await persistReplacementNodesTx(tx, {
      task,
      actorAccountId: refreshedActor.accountId,
      milestones: replacement.milestones,
      termination: replacement.termination,
    });
    await tx.planVersionNode.createMany({
      data: [
        ...replacement.milestones.map((milestone, index) => ({
          planVersionId: plan.id,
          nodeId: milestone.nodeId,
          sequence: index + 1,
          isCarryForward: false,
        })),
        {
          planVersionId: plan.id,
          nodeId: replacement.termination.nodeId,
          sequence: replacement.milestones.length + 1,
          isCarryForward: false,
        },
      ],
    });
    await tx.taskPlanVersion.update({
      where: { id: plan.id },
      data: { plannedStartAt: parsed.plannedStartAt },
    });

    const authoritativePlan = await loadPlanForMutationTx(tx, plan.id);
    assertAuthoritativePlanValid(authoritativePlan);
    const snapshotHash = hashPlan(authoritativePlan);
    await tx.taskPlanVersion.update({
      where: { id: plan.id },
      data: { snapshotHash },
    });
    const updatedTask = await incrementTaskLockTx(
      tx,
      task,
      parsed.expectedLockVersion,
    );
    const afterPlan = auditPlanState({
      ...authoritativePlan,
      snapshotHash,
    });
    const planChanges = summarizePlanChanges(plan, authoritativePlan);
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action: "pm.task.draft_plan.replace",
      entityType: "TaskPlanVersion",
      entityId: plan.id,
      taskId: task.id,
      before: jsonValue({
        ...beforePlan,
        lockVersion: task.lockVersion,
      }),
      after: jsonValue({
        ...afterPlan,
        lockVersion: updatedTask.lockVersion,
        changes: planChanges,
      }),
      reason: "更新 Task 草稿计划",
    });

    return {
      ...serializeTaskMutation(updatedTask),
      planVersionId: plan.id,
      plannedStartAt: parsed.plannedStartAt.toISOString(),
      snapshotHash,
      nodeMappings: replacement.nodeMappings,
      nodes: authoritativePlan.nodes.map((entry) => ({
        nodeId: entry.nodeId,
        sequence: entry.sequence,
        type: entry.node.type,
      })),
    };
  });
}

async function updateTaskMetadataForStatus(
  actor: ProjectManagementActor,
  parsed: UpdateTaskDraftMetadataInput | UpdateTaskMetadataInput,
  requiredStatus: "DRAFT" | "ACTIVE",
): Promise<TaskMetadataMutationResult> {
  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task } = await loadLockedTaskTx(
      tx,
      actor,
      parsed.taskId,
    );
    assertAuthorizedTaskAction(refreshedActor, task, "task.update_metadata");
    assertTaskStatus(task, requiredStatus);
    assertExpectedLockVersion(task, parsed.expectedLockVersion);
    assertAuthorizedTargetScope(refreshedActor, task, parsed);
    await assertRelatedTaskVisibleTx(
      tx,
      refreshedActor,
      task.id,
      parsed.relatedTaskId,
      task.relatedTaskId,
    );
    const targetProjectId = parsed.projectId === undefined ? task.projectId : parsed.projectId;
    await assertTaskProjectChangeAllowedTx(tx, task.projectId, targetProjectId);
    const before = metadataSnapshot(task);
    const updatedCount = await tx.task.updateMany({
      where: {
        id: task.id,
        lockVersion: parsed.expectedLockVersion,
        status: requiredStatus,
        deletedAt: null,
      },
      data: {
        title: parsed.title,
        description: parsed.description,
        team: parsed.team,
        techGroup: parsed.techGroup,
        priority: parsed.priority,
        relatedTaskId: parsed.relatedTaskId,
        projectId: parsed.projectId,
        lockVersion: { increment: 1 },
      },
    });
    if (updatedCount.count !== 1) {
      throw staleTaskError(task);
    }

    const updatedTask = await loadTaskAfterMutationTx(tx, task.id);
    await syncTaskMembersToProjectTx(tx, { projectId: targetProjectId, taskId: task.id, members: updatedTask.members, actor: refreshedActor });
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action:
        requiredStatus === "DRAFT"
          ? "pm.task.draft_metadata.update"
          : "pm.task.metadata.update",
      entityType: "Task",
      entityId: task.id,
      taskId: task.id,
      before: jsonValue(before),
      after: jsonValue(metadataSnapshot(updatedTask)),
      reason: "更新 Task 元数据",
    });
    await auditTaskProjectChangeTx(tx, refreshedActor, task, updatedTask);

    return {
      ...serializeTaskMutation(updatedTask),
    };
  });
}

async function replaceTaskMembersForStatus(
  actor: ProjectManagementActor,
  parsed: ReplaceTaskDraftMembersInput | ReplaceTaskMembersInput,
  requiredStatus: "DRAFT" | "ACTIVE",
): Promise<TaskMembersMutationResult> {
  return prisma.$transaction(async (tx) => {
    const { refreshedActor, task } = await loadLockedTaskTx(
      tx,
      actor,
      parsed.taskId,
    );
    assertAuthorizedTaskAction(refreshedActor, task, "task.manage_members");
    assertTaskStatus(task, requiredStatus);
    assertExpectedLockVersion(task, parsed.expectedLockVersion);
    assertExistingMemberInvariant(task.members);
    assertRequestedMemberInvariant(parsed.members);
    await assertActivePeopleTx(
      tx,
      parsed.members.map((member) => member.personId),
      task.members.map((member) => member.personId),
    );
    await assertTaskSegmentMembersIncludedTx(tx, task.id, parsed.members);

    const beforeMembers = memberSnapshot(task.members);
    const changes = calculateMemberChanges(task.members, parsed.members);
    await applyMemberChangesTx(tx, {
      taskId: task.id,
      actorAccountId: refreshedActor.accountId,
      currentMembers: task.members,
      requestedMembers: parsed.members,
    });
    await syncTaskMembersToProjectTx(tx, { projectId: task.projectId, taskId: task.id, members: parsed.members, actor: refreshedActor });
    const updatedTask = await incrementTaskLockTx(
      tx,
      task,
      parsed.expectedLockVersion,
    );
    const afterMembers = memberSnapshot(parsed.members);
    await createDomainAuditEventTx(tx, {
      actorAccountId: refreshedActor.accountId,
      actorPersonId: refreshedActor.personId,
      action:
        requiredStatus === "DRAFT"
          ? "pm.task.draft_members.replace"
          : "pm.task.members.replace",
      entityType: "Task",
      entityId: task.id,
      taskId: task.id,
      before: jsonValue({
        members: beforeMembers,
        lockVersion: task.lockVersion,
      }),
      after: jsonValue({
        members: afterMembers,
        lockVersion: updatedTask.lockVersion,
      }),
      reason:
        requiredStatus === "DRAFT"
          ? "更新 Task 草稿成员"
          : "更新 Active Task 成员",
    });

    if (requiredStatus === "ACTIVE" && changes.length > 0) {
      await notifyActiveMemberChangesTx(tx, {
        actor: refreshedActor,
        task,
        lockVersion: updatedTask.lockVersion,
        changes,
      });
    }

    return {
      ...serializeTaskMutation(updatedTask),
      members: afterMembers,
    };
  });
}

async function loadLockedTaskTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  taskId: string,
): Promise<{
  refreshedActor: ProjectManagementActor;
  task: TaskForMutation;
}> {
  await acquireProjectCrossAggregateLockTx(tx);
  const lockedTaskIds = await lockTaskSegmentAssociationsTx(tx, [taskId]);
  if (!lockedTaskIds.has(taskId)) throw notFoundError();

  const refreshedActor = await refreshProjectManagementActorTx(tx, actor);
  const task = await tx.task.findUnique({
    where: { id: taskId },
    include: taskMutationInclude,
  });
  if (!task || task.deletedAt) throw notFoundError();
  const visible = authorize({
    actor: refreshedActor,
    action: "task.view",
    resource: taskResource(task),
  });
  if (!visible.allowed) throw notFoundError();
  return { refreshedActor, task };
}

function taskResource(task: TaskForMutation): AuthorizationTaskResource {
  return {
    type: "task",
    id: task.id,
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    priority: task.priority,
    members: task.members,
  };
}

function assertAuthorizedTaskAction(
  actor: ProjectManagementActor,
  task: TaskForMutation,
  action: "task.update_metadata" | "task.manage_members",
) {
  assertAuthorized({ actor, action, resource: taskResource(task) });
}

function assertAuthorizedTargetScope(
  actor: ProjectManagementActor,
  task: TaskForMutation,
  input: Pick<UpdateTaskMetadataInput, "team" | "techGroup">,
) {
  assertAuthorized({
    actor,
    action: "task.update_metadata",
    resource: {
      ...taskResource(task),
      team: input.team,
      techGroup: input.techGroup,
    },
  });
}

function assertTaskStatus(
  task: TaskForMutation,
  requiredStatus: "DRAFT" | "ACTIVE",
) {
  if (task.status !== requiredStatus) {
    throw stateConflictError(
      requiredStatus === "DRAFT"
        ? "只有草稿 Task 可以执行此操作"
        : "只有执行中的 Task 可以执行此操作",
    );
  }
}

function assertExpectedLockVersion(
  task: TaskForMutation,
  expectedLockVersion: number,
) {
  if (task.lockVersion !== expectedLockVersion) {
    throw staleTaskError(task);
  }
}

async function assertRelatedTaskVisibleTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
  taskId: string,
  relatedTaskId: string | null,
  currentRelatedTaskId: string | null,
) {
  if (!relatedTaskId) return;
  if (relatedTaskId === taskId) {
    throw associationInvalidError("Task 不能关联自身", {
      relatedTaskId: ["Task 不能关联自身"],
    });
  }
  if (relatedTaskId === currentRelatedTaskId) return;
  const relatedTask = await tx.task.findFirst({
    where: {
      AND: [{ id: relatedTaskId }, taskReadableWhere(actor)],
    },
    select: { id: true },
  });
  if (!relatedTask) throw notFoundError();
}

async function assertActivePeopleTx(
  tx: PrismaTx,
  personIds: string[],
  existingPersonIds: string[] = [],
) {
  const existing = new Set(existingPersonIds);
  const uniquePersonIds = [...new Set(personIds)].filter(
    (personId) => !existing.has(personId),
  );
  if (uniquePersonIds.length === 0) return;
  const count = await tx.person.count({
    where: { id: { in: uniquePersonIds }, status: "ACTIVE" },
  });
  if (count !== uniquePersonIds.length) {
    throw validationError("成员不存在或已停用", {
      members: ["成员不存在或已停用"],
    });
  }
}

function assertExistingMemberInvariant(
  members: Array<{ personId: string; role: TaskMemberRole }>,
) {
  const personIds = members.map((member) => member.personId);
  if (new Set(personIds).size !== personIds.length) {
    throw stateConflictError("Task 当前成员数据存在重复成员，请联系管理员处理");
  }
  if (
    members.some(
      (member) => member.role !== "OWNER" && member.role !== "PARTICIPANT",
    )
  ) {
    throw stateConflictError("Task 当前成员仍含历史角色，请联系管理员处理");
  }
  if (members.every((member) => member.role !== "OWNER")) {
    throw stateConflictError("Task 当前没有负责人，请联系管理员处理");
  }
}

function assertRequestedMemberInvariant(
  members: Array<{ personId: string; role: TaskMemberRole }>,
) {
  const personIds = members.map((member) => member.personId);
  if (new Set(personIds).size !== personIds.length) {
    throw validationError("同一成员只能有一个角色", {
      members: ["同一成员只能有一个角色"],
    });
  }
  if (members.every((member) => member.role !== "OWNER")) {
    throw validationError("至少需要一名负责人", {
      members: ["至少需要一名负责人"],
    });
  }
}

async function assertTaskSegmentMembersIncludedTx(
  tx: PrismaTx,
  taskId: string,
  requestedMembers: Array<{ personId: string }>,
) {
  const retainedPersonIds = requestedMembers.map((member) => member.personId);
  const orphanedSegment = await tx.workSegment.findFirst({
    where: {
      taskId,
      deletedAt: null,
      personId: { notIn: retainedPersonIds },
    },
    select: { id: true },
  });
  if (orphanedSegment) {
    throw validationError("仍有关联投入的成员不能移出 Task", {
      members: ["请先处理该成员的 Task 关联投入"],
    });
  }
}

async function applyMemberChangesTx(
  tx: PrismaTx,
  input: {
    taskId: string;
    actorAccountId: string;
    currentMembers: Array<{
      id: string;
      personId: string;
      role: TaskMemberRole;
    }>;
    requestedMembers: Array<{ personId: string; role: TaskMemberRole }>;
  },
) {
  const requestedKeys = new Set(input.requestedMembers.map(memberKey));
  const currentKeys = new Set(input.currentMembers.map(memberKey));
  const removedIds = input.currentMembers
    .filter((member) => !requestedKeys.has(memberKey(member)))
    .map((member) => member.id);
  const added = input.requestedMembers.filter(
    (member) => !currentKeys.has(memberKey(member)),
  );
  if (removedIds.length > 0) {
    await tx.taskMember.updateMany({
      where: { id: { in: removedIds }, taskId: input.taskId, removedAt: null },
      data: { removedAt: new Date() },
    });
  }
  if (added.length > 0) {
    await tx.taskMember.createMany({
      data: added.map((member) => ({
        taskId: input.taskId,
        personId: member.personId,
        role: member.role,
        createdByAccountId: input.actorAccountId,
      })),
    });
  }
}

type MemberChange = {
  personId: string;
  beforeRoles: TaskMemberRole[];
  afterRoles: TaskMemberRole[];
  kind: "ADDED" | "REMOVED" | "ROLES_CHANGED";
};

function calculateMemberChanges(
  currentMembers: Array<{ personId: string; role: TaskMemberRole }>,
  requestedMembers: Array<{ personId: string; role: TaskMemberRole }>,
): MemberChange[] {
  const before = rolesByPerson(currentMembers);
  const after = rolesByPerson(requestedMembers);
  const personIds = new Set([...before.keys(), ...after.keys()]);
  return [...personIds]
    .sort()
    .flatMap((personId) => {
      const beforeRoles = before.get(personId) ?? [];
      const afterRoles = after.get(personId) ?? [];
      if (sameStringArray(beforeRoles, afterRoles)) return [];
      return [
        {
          personId,
          beforeRoles,
          afterRoles,
          kind:
            beforeRoles.length === 0
              ? "ADDED"
              : afterRoles.length === 0
                ? "REMOVED"
                : "ROLES_CHANGED",
        } satisfies MemberChange,
      ];
    });
}

async function notifyActiveMemberChangesTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    task: TaskForMutation;
    lockVersion: number;
    changes: MemberChange[];
  },
) {
  const actorName = await actorDisplayNameTx(tx, input.actor);
  for (const change of input.changes) {
    const recipientResolution = await resolveMandatoryMemberRecipientTx(
      tx,
      change.personId,
    );
    const beforeLabel = roleListLabel(change.beforeRoles);
    const afterLabel = roleListLabel(change.afterRoles);
    const actionLabel =
      change.kind === "ADDED"
        ? "加入"
        : change.kind === "REMOVED"
          ? "移出"
          : "调整角色";
    await createProjectManagementEventNotificationsTx(tx, {
      actor: input.actor,
      task: {
        id: input.task.id,
        title: input.task.title,
        status: "ACTIVE",
        currentPlanVersionId: input.task.currentPlanVersionId,
      },
      kind: "task_assigned",
      category: "TASK",
      eventKey: `pm:task:member_changed:${input.task.id}:${input.lockVersion}:${change.personId}`,
      title: "Task 成员变更",
      summary: `${actorName}已将你在 Task「${input.task.title}」中的成员关系${actionLabel}：${beforeLabel} → ${afterLabel}`,
      entityType: "Task",
      entityId: input.task.id,
      linkPath: PROGRESS_LINK,
      mandatory: true,
      recipients: recipientResolution.recipients,
      context: {
        changeKind: change.kind,
        affectedPersonId: change.personId,
        beforeRoles: change.beforeRoles,
        afterRoles: change.afterRoles,
        result: "SUCCESS",
        taskLockVersion: input.lockVersion,
        recipientResolution: recipientResolution.status,
      },
    });
  }
}

async function resolveMandatoryMemberRecipientTx(
  tx: PrismaTx,
  personId: string,
): Promise<{
  status:
    | "RESOLVED"
    | "PERSON_INACTIVE"
    | "ACCOUNT_MISSING"
    | "DEFAULT_FEISHU_IDENTITY_MISSING"
    | "FEISHU_OPEN_ID_MISSING";
  recipients: Array<{ accountId: string; openId: string | null }>;
}> {
  const person = await tx.person.findUnique({
    where: { id: personId },
    select: {
      status: true,
      account: {
        select: {
          id: true,
          identities: {
            where: {
              provider: "FEISHU",
              tenantId: DEFAULT_FEISHU_TENANT_ID,
            },
            select: { id: true, openId: true },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      },
    },
  });
  if (!person?.account) {
    return { status: "ACCOUNT_MISSING", recipients: [] };
  }
  const openId = person.account.identities
    .map((identity) => identity.openId?.trim() ?? "")
    .find(Boolean) ?? null;
  const status =
    person.status !== "ACTIVE"
      ? "PERSON_INACTIVE"
      : person.account.identities.length === 0
        ? "DEFAULT_FEISHU_IDENTITY_MISSING"
        : !openId
          ? "FEISHU_OPEN_ID_MISSING"
          : "RESOLVED";
  return {
    status,
    recipients: [
      {
        accountId: person.account.id,
        openId: status === "RESOLVED" ? openId : null,
      },
    ],
  };
}

async function actorDisplayNameTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
) {
  const person = await tx.person.findUnique({
    where: { id: actor.personId },
    select: { displayName: true },
  });
  return person?.displayName ?? "系统用户";
}

async function loadInitialDraftPlanTx(
  tx: PrismaTx,
  task: TaskForMutation,
  planVersionId: string,
): Promise<PlanForMutation> {
  const plan = await tx.taskPlanVersion.findFirst({
    where: {
      id: planVersionId,
      taskId: task.id,
      status: "CURRENT",
      activatedAt: null,
    },
    include: {
      nodes: {
        include: planNodeInclude,
        orderBy: { sequence: "asc" },
      },
    },
  });
  if (
    !plan ||
    task.currentPlanVersionId !== plan.id ||
    plan.versionNo !== 1 ||
    plan.baseVersionId !== null ||
    plan.revisionNodeId !== null
  ) {
    throw stateConflictError("只有未激活的初始 Current Plan 可以整包更新");
  }
  if (
    plan.nodes.some(
      (entry) =>
        entry.node.taskId !== task.id ||
        entry.node.deletedAt !== null ||
        entry.node.type === "REVISION" ||
        entry.node.status !== "PENDING",
    )
  ) {
    throw stateConflictError("Task 草稿计划状态不正确，请刷新后重试");
  }
  return plan;
}

type ResolvedMilestoneReplacement = {
  nodeId: string;
  existing: boolean;
  input: ReplaceTaskDraftPlanInput["milestones"][number];
};

type ResolvedTerminationReplacement = {
  nodeId: string;
  existing: boolean;
  input: ReplaceTaskDraftPlanInput["termination"];
};

async function resolveDraftPlanReplacementTx(
  tx: PrismaTx,
  plan: PlanForMutation,
  input: ReplaceTaskDraftPlanInput,
): Promise<{
  milestones: ResolvedMilestoneReplacement[];
  termination: ResolvedTerminationReplacement;
  omittedEntries: PlanEntry[];
  nodeMappings: Array<{ clientKey: string; nodeId: string }>;
}> {
  const existingById = new Map(
    plan.nodes.map((entry) => [entry.nodeId, entry] as const),
  );
  const nodeMappings: Array<{ clientKey: string; nodeId: string }> = [];
  const resolveNodeId = (identity: {
    nodeId?: string;
    clientKey?: string;
  }) => {
    if (identity.nodeId) return identity.nodeId;
    const clientKey = identity.clientKey;
    if (!clientKey) {
      throw associationInvalidError("计划节点缺少 nodeId 或 clientKey");
    }
    const nodeId = stableDraftNodeId(plan.id, clientKey);
    nodeMappings.push({ clientKey, nodeId });
    return nodeId;
  };

  const milestones = input.milestones.map((milestone) => ({
    nodeId: resolveNodeId(milestone),
    existing: false,
    input: milestone,
  }));
  const termination: ResolvedTerminationReplacement = {
    nodeId: resolveNodeId(input.termination),
    existing: false,
    input: input.termination,
  };
  const allResolved = [...milestones, termination];
  const resolvedIds = allResolved.map((entry) => entry.nodeId);
  if (new Set(resolvedIds).size !== resolvedIds.length) {
    throw associationInvalidError("计划节点标识发生冲突", {
      nodes: ["计划节点标识发生冲突"],
    });
  }

  // A caller-supplied nodeId is only a reference to a node already present in
  // this exact plan. New nodes are created exclusively from clientKey so a
  // random ID and an ID from another Task have indistinguishable semantics.
  if (
    allResolved.some(
      (entry) => entry.input.nodeId && !existingById.has(entry.nodeId),
    )
  ) {
    throw associationInvalidError("计划节点不属于当前 Task 草稿计划");
  }

  const foreignOrHistoricalNodes = await tx.taskNode.findMany({
    where: {
      id: {
        in: allResolved
          .filter(
            (entry) =>
              Boolean(entry.input.clientKey) && !existingById.has(entry.nodeId),
          )
          .map((entry) => entry.nodeId),
      },
    },
    select: { id: true },
  });
  if (foreignOrHistoricalNodes.length > 0) {
    throw associationInvalidError("计划节点不属于当前 Task 草稿计划");
  }

  for (const milestone of milestones) {
    const existing = existingById.get(milestone.nodeId);
    if (existing) {
      if (existing.node.type !== "MILESTONE" || !existing.node.milestone) {
        throw associationInvalidError("Milestone nodeId 不属于当前计划");
      }
      milestone.existing = true;
    }
  }
  const existingTermination = existingById.get(termination.nodeId);
  if (existingTermination) {
    if (
      existingTermination.node.type !== "TERMINATION" ||
      !existingTermination.node.termination
    ) {
      throw associationInvalidError("Termination nodeId 不属于当前计划");
    }
    termination.existing = true;
  }

  const retainedIds = new Set(resolvedIds);
  const omittedEntries = plan.nodes.filter(
    (entry) => !retainedIds.has(entry.nodeId),
  );
  return {
    milestones,
    termination,
    omittedEntries,
    nodeMappings,
  };
}

async function deleteOmittedDraftNodesTx(
  tx: PrismaTx,
  entries: PlanEntry[],
) {
  if (entries.length === 0) return;
  const milestoneNodeIds = entries
    .filter((entry) => entry.node.type === "MILESTONE")
    .map((entry) => entry.nodeId);
  const terminationNodeIds = entries
    .filter((entry) => entry.node.type === "TERMINATION")
    .map((entry) => entry.nodeId);
  if (milestoneNodeIds.length > 0) {
    await tx.milestoneNode.deleteMany({
      where: { nodeId: { in: milestoneNodeIds } },
    });
  }
  if (terminationNodeIds.length > 0) {
    await tx.terminationNode.deleteMany({
      where: { nodeId: { in: terminationNodeIds } },
    });
  }
  await tx.taskNode.deleteMany({
    where: { id: { in: entries.map((entry) => entry.nodeId) } },
  });
}

async function persistReplacementNodesTx(
  tx: PrismaTx,
  input: {
    task: TaskForMutation;
    actorAccountId: string;
    milestones: ResolvedMilestoneReplacement[];
    termination: ResolvedTerminationReplacement;
  },
) {
  for (const milestone of input.milestones) {
    if (milestone.existing) {
      await tx.taskNode.update({
        where: { id: milestone.nodeId },
        data: { businessDescription: milestone.input.businessDescription },
      });
      await tx.milestoneNode.update({
        where: { nodeId: milestone.nodeId },
        data: {
          goal: milestone.input.goal,
          completionCriteria: milestone.input.completionCriteria,
          expectedCompletedAt: milestone.input.expectedCompletedAt,
          reviewRequirements: milestone.input.reviewRequirements,
        },
      });
    } else {
      await tx.taskNode.create({
        data: {
          id: milestone.nodeId,
          taskId: input.task.id,
          type: "MILESTONE",
          status: "PENDING",
          businessDescription: milestone.input.businessDescription,
          createdByAccountId: input.actorAccountId,
          milestone: {
            create: {
              goal: milestone.input.goal,
              completionCriteria: milestone.input.completionCriteria,
              expectedCompletedAt: milestone.input.expectedCompletedAt,
              reviewRequirements: milestone.input.reviewRequirements,
            },
          },
        },
      });
    }
  }

  if (input.termination.existing) {
    await tx.taskNode.update({
      where: { id: input.termination.nodeId },
      data: {
        businessDescription:
          input.termination.input.businessDescription,
      },
    });
    await tx.terminationNode.update({
      where: { nodeId: input.termination.nodeId },
      data: {
        name: input.termination.input.name,
        plannedOutcomeCriteria:
          input.termination.input.plannedOutcomeCriteria,
        plannedAt: input.termination.input.plannedAt,
      },
    });
  } else {
    await tx.taskNode.create({
      data: {
        id: input.termination.nodeId,
        taskId: input.task.id,
        type: "TERMINATION",
        status: "PENDING",
        businessDescription:
          input.termination.input.businessDescription,
        createdByAccountId: input.actorAccountId,
        termination: {
          create: {
            name: input.termination.input.name,
            plannedOutcomeCriteria:
              input.termination.input.plannedOutcomeCriteria,
            plannedAt: input.termination.input.plannedAt,
          },
        },
      },
    });
  }
}

async function loadPlanForMutationTx(
  tx: PrismaTx,
  planVersionId: string,
): Promise<PlanForMutation> {
  const plan = await tx.taskPlanVersion.findUnique({
    where: { id: planVersionId },
    include: {
      nodes: {
        include: planNodeInclude,
        orderBy: { sequence: "asc" },
      },
    },
  });
  if (!plan) throw stateConflictError("计划版本不存在");
  return plan;
}

function assertAuthoritativePlanValid(plan: PlanForMutation) {
  assertPersistedPlanChronologyValid(plan);
}

function hashPlan(plan: PlanForMutation) {
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

function auditPlanState(plan: PlanForMutation) {
  return {
    plannedStartAt: plan.plannedStartAt?.toISOString() ?? null,
    snapshotHash: plan.snapshotHash,
    nodeCount: plan.nodes.length,
  };
}

function summarizePlanChanges(
  beforePlan: PlanForMutation,
  afterPlan: PlanForMutation,
) {
  const beforeById = new Map(
    beforePlan.nodes.map((entry) => [entry.nodeId, entry] as const),
  );
  const afterById = new Map(
    afterPlan.nodes.map((entry) => [entry.nodeId, entry] as const),
  );
  const retained = afterPlan.nodes.filter((entry) => beforeById.has(entry.nodeId));
  const added = afterPlan.nodes.filter((entry) => !beforeById.has(entry.nodeId));
  const removed = beforePlan.nodes.filter((entry) => !afterById.has(entry.nodeId));
  const reordered = retained.flatMap((entry) => {
    const before = beforeById.get(entry.nodeId);
    if (!before || before.sequence === entry.sequence) return [];
    return [{
      nodeId: entry.nodeId,
      type: entry.node.type,
      beforeSequence: before.sequence,
      afterSequence: entry.sequence,
    }];
  });
  const changedNodes = retained.flatMap((entry) => {
    const before = beforeById.get(entry.nodeId);
    if (!before) return [];
    const beforeFields = planNodeComparableFields(before);
    const afterFields = planNodeComparableFields(entry);
    const fields = Object.keys(afterFields).filter(
      (field) => beforeFields[field] !== afterFields[field],
    );
    return fields.length > 0
      ? [{ nodeId: entry.nodeId, type: entry.node.type, fields }]
      : [];
  });
  const fieldCounts: Record<string, number> = {};
  for (const node of changedNodes) {
    for (const field of node.fields) {
      fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
    }
  }
  return {
    retained: boundedPlanAuditDetails(retained.map(planNodeIdentity)),
    added: boundedPlanAuditDetails(added.map(planNodeIdentity)),
    removed: boundedPlanAuditDetails(removed.map(planNodeIdentity)),
    reordered: boundedPlanAuditDetails(reordered),
    fieldChanges: {
      plannedStartAtChanged:
        beforePlan.plannedStartAt?.toISOString() !==
        afterPlan.plannedStartAt?.toISOString(),
      nodeCount: changedNodes.length,
      byField: fieldCounts,
      nodes: boundedPlanAuditDetails(changedNodes),
    },
  };
}

function planNodeIdentity(entry: PlanEntry) {
  return { nodeId: entry.nodeId, type: entry.node.type };
}

function boundedPlanAuditDetails<T>(entries: T[]) {
  return {
    totalCount: entries.length,
    truncated: entries.length > PLAN_AUDIT_NODE_DETAIL_LIMIT,
    entries: entries.slice(0, PLAN_AUDIT_NODE_DETAIL_LIMIT),
  };
}

function planNodeComparableFields(entry: PlanEntry): Record<string, string | null> {
  return {
    type: entry.node.type,
    businessDescription: entry.node.businessDescription,
    goal: entry.node.milestone?.goal ?? null,
    completionCriteria: entry.node.milestone?.completionCriteria ?? null,
    expectedCompletedAt:
      entry.node.milestone?.expectedCompletedAt.toISOString() ?? null,
    reviewRequirements: entry.node.milestone?.reviewRequirements ?? null,
    plannedOutcomeCriteria:
      entry.node.termination?.plannedOutcomeCriteria ?? null,
    terminationName: entry.node.termination?.name ?? null,
    plannedAt: entry.node.termination?.plannedAt.toISOString() ?? null,
  };
}

function stableDraftNodeId(planVersionId: string, clientKey: string) {
  const hex = createHash("sha256")
    .update(`pm:draft-plan-node:${planVersionId}:${clientKey}`)
    .digest("hex")
    .slice(0, 32);
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function incrementTaskLockTx(
  tx: PrismaTx,
  task: TaskForMutation,
  expectedLockVersion: number,
) {
  const updated = await tx.task.updateMany({
    where: {
      id: task.id,
      lockVersion: expectedLockVersion,
      status: task.status,
      deletedAt: null,
    },
    data: { lockVersion: { increment: 1 } },
  });
  if (updated.count !== 1) throw staleTaskError(task);
  return loadTaskAfterMutationTx(tx, task.id);
}

async function loadTaskAfterMutationTx(tx: PrismaTx, taskId: string) {
  return tx.task.findUniqueOrThrow({
    where: { id: taskId },
    include: taskMutationInclude,
  });
}

function serializeTaskMutation(task: TaskForMutation): TaskMutationResult {
  return {
    taskId: task.id,
    status: task.status,
    currentPlanVersionId: task.currentPlanVersionId,
    lockVersion: task.lockVersion,
    updatedAt: task.updatedAt.toISOString(),
  };
}

function metadataSnapshot(task: TaskForMutation) {
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

async function auditTaskProjectChangeTx(
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
  const projectIds = [beforeTask.projectId, afterTask.projectId].filter((id): id is string => Boolean(id));
  const projects = projectIds.length
    ? await tx.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true, members: { where: { removedAt: null, role: "OWNER" }, select: { personId: true } } } })
    : [];
  const recipientPersonIds = [...new Set([...afterTask.members.filter((member) => member.role === "OWNER" || member.role === "PARTICIPANT").map((member) => member.personId), ...projects.flatMap((project) => project.members.map((member) => member.personId))])];
  const recipients = await recipientsForPersonIdsTx(tx, recipientPersonIds);
  const primaryProject = projects.find((project) => project.id === afterTask.projectId) ?? projects[0];
  await createProjectManagementEventNotificationsTx(tx, {
    actor,
    task: { id: afterTask.id, title: afterTask.title, status: afterTask.status },
    project: primaryProject ? { id: primaryProject.id, name: primaryProject.name } : null,
    kind: "project_task_changed",
    category: "PROJECT",
    eventKey: `pm:task:${afterTask.id}:project:${afterTask.lockVersion}`,
    title: "Task 所属 Project 已变更",
    summary: afterTask.projectId ? `Task「${afterTask.title}」已${beforeTask.projectId ? "移动" : "加入"} Project「${primaryProject?.name ?? "Project"}」` : `Task「${afterTask.title}」已移出 Project`,
    entityType: "Task",
    entityId: afterTask.id,
    linkPath: `/progress/tasks/${afterTask.id}`,
    mandatory: false,
    recipients,
    context: { beforeProjectId: beforeTask.projectId, afterProjectId: afterTask.projectId },
  });
}

function taskMetadataMatches(
  task: TaskForMutation,
  metadata: Pick<
    UpdateTaskMetadataInput,
    "title" | "description" | "team" | "techGroup" | "priority" | "relatedTaskId" | "projectId"
  >,
) {
  return (
    task.title === metadata.title &&
    task.description === metadata.description &&
    task.team === metadata.team &&
    task.techGroup === metadata.techGroup &&
    task.priority === metadata.priority &&
    task.relatedTaskId === metadata.relatedTaskId &&
    (metadata.projectId === undefined || task.projectId === metadata.projectId)
  );
}

function memberSnapshot(
  members: Array<{ personId: string; role: TaskMemberRole }>,
) {
  return members
    .map((member) => ({ personId: member.personId, role: member.role }))
    .sort(
      (left, right) =>
        left.personId.localeCompare(right.personId) ||
        left.role.localeCompare(right.role),
    );
}

function memberKey(member: { personId: string; role: TaskMemberRole }) {
  return `${member.personId}:${member.role}`;
}

function rolesByPerson(
  members: Array<{ personId: string; role: TaskMemberRole }>,
) {
  const result = new Map<string, TaskMemberRole[]>();
  for (const member of members) {
    const roles = result.get(member.personId) ?? [];
    roles.push(member.role);
    result.set(member.personId, roles);
  }
  for (const roles of result.values()) roles.sort();
  return result;
}

function roleListLabel(roles: TaskMemberRole[]) {
  if (roles.length === 0) return "无";
  return roles.map((role) => taskMemberRoleLabels[role]).join("、");
}

function sameStringArray(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
