import { createHash } from "node:crypto";
import type {
  Prisma,
  TaskMemberRole,
  TaskNodeType,
  TaskStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  associationInvalidError,
  staleTaskError,
  stateConflictError,
} from "@/lib/project-management/application/errors";
import { assertPersistedPlanChronologyValid } from "@/lib/project-management/application/persisted-plan-chronology";
import {
  updateActiveTaskInputSchema,
  updateTaskDraftInputSchema,
  type UpdateActiveTaskInput,
  type UpdateTaskDraftInput,
} from "@/lib/project-management/validations/task-mutations";
import {
  assertTaskProjectChangeAllowedTx,
  syncTaskMembersToProjectTx,
} from "@/lib/project-management/application/project-service";
import {
  taskMutationInclude,
  taskMutationPlanNodeInclude,
  type PlanForMutation,
  type TaskForMutation,
  type TaskMutationPlanEntry,
} from "@/lib/project-management/application/task-mutation-records";
import {
  auditPlanState,
  hashTaskMutationPlan,
  summarizePlanChanges,
} from "@/lib/project-management/application/task-plan-audit";
import {
  calculateMemberChanges,
  notifyTaskMemberChangesTx,
  type MemberChange,
} from "@/lib/project-management/application/task-member-notifications";
import {
  assertAuthorizedTargetScope,
  assertAuthorizedTaskAction,
  assertExpectedLockVersion,
  assertRelatedTaskVisibleTx,
  assertTaskStatus,
  loadLockedTaskTx,
} from "@/lib/project-management/application/task-mutation-context";
import {
  applyMemberChangesTx,
  assertActivePeopleTx,
  assertExistingActiveMemberInvariant,
  assertExistingMemberStructure,
  assertRequestedActiveMemberInvariant,
  assertRequestedMemberStructure,
  assertTaskSegmentMembersIncludedTx,
  memberKey,
  memberSnapshot,
} from "@/lib/project-management/application/task-member-mutations";
import {
  auditTaskProjectChangeTx,
  metadataSnapshot,
  notifyTaskUpdatedTx,
} from "@/lib/project-management/application/task-metadata-effects";
import { jsonValue } from "@/lib/project-management/application/prisma-json";

type PrismaTx = Prisma.TransactionClient;

const planNodeInclude = taskMutationPlanNodeInclude;
type PlanEntry = TaskMutationPlanEntry;

export type TaskMutationResult = {
  taskId: string;
  status: TaskStatus;
  currentPlanVersionId: string;
  lockVersion: number;
  updatedAt: string;
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

    let memberChanges: MemberChange[] = [];
    if (parsed.members) {
      assertAuthorizedTaskAction(refreshedActor, task, "task.manage_members");
      assertExistingMemberStructure(task.members);
      assertRequestedMemberStructure(parsed.members);
      await assertActivePeopleTx(
        tx,
        parsed.members.map((member) => member.personId),
        task.members.map((member) => member.personId),
      );
      await assertTaskSegmentMembersIncludedTx(tx, task.id, parsed.members);
      memberChanges = calculateMemberChanges(task.members, parsed.members);
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
    const snapshotHash = hashTaskMutationPlan(authoritativePlan);
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
    await notifyTaskUpdatedTx(tx, refreshedActor, task, updatedTask);
    if (memberChanges.length > 0) {
      await notifyTaskMemberChangesTx(tx, {
        actor: refreshedActor,
        task: updatedTask,
        lockVersion: updatedTask.lockVersion,
        changes: memberChanges,
      });
    }

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
      assertExistingActiveMemberInvariant(task.members);
      assertRequestedActiveMemberInvariant(parsed.members);
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
      await notifyTaskUpdatedTx(tx, refreshedActor, task, updatedTask);
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
      await notifyTaskMemberChangesTx(tx, {
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
  input: UpdateTaskDraftInput["milestones"][number];
};

type ResolvedTerminationReplacement = {
  nodeId: string;
  existing: boolean;
  input: UpdateTaskDraftInput["termination"];
};

async function resolveDraftPlanReplacementTx(
  tx: PrismaTx,
  plan: PlanForMutation,
  input: Pick<UpdateTaskDraftInput, "milestones" | "termination">,
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

function taskMetadataMatches(
  task: TaskForMutation,
  metadata: Pick<
    NonNullable<UpdateActiveTaskInput["metadata"]>,
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

function sameStringArray(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
