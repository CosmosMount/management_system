import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { ProjectManagementSystemRole, TaskMemberRole, WorkSegmentStatus, WorkSegmentType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { createTaskDraft, reviewMilestone, submitMilestoneForReview } from "../../lib/project-management/application/lifecycle-service";
import { updateActiveTask, updateTaskDraft } from "../../lib/project-management/application/task-mutation-service";
import { toProjectManagementServiceError } from "../../lib/project-management/application/errors";
import type { ProjectManagementActor } from "../../lib/project-management/identity";
import { cleanupBarrierResources, connectDatabaseClient, startBarrierOperations, throwBarrierErrors } from "./database-barrier";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MUTATION_ACTION_CASES = [
  {
    name: "updateTaskDraft",
    requiredStatus: "DRAFT",
    auditAction: "pm.task.draft.update",
  },
  {
    name: "updateActiveTask",
    requiredStatus: "ACTIVE",
    auditAction: "pm.task.metadata.update",
  },
] as const;

export type AccountPerson = Awaited<ReturnType<typeof createAccountPerson>>;

export type DraftFixture = Awaited<ReturnType<typeof createDraft>>;

export type MutationActionName = (typeof MUTATION_ACTION_CASES)[number]["name"];

export type PlanEntryFixture = Awaited<ReturnType<typeof currentPlan>>["nodes"][number];

export async function invokeMutationAction(
  name: MutationActionName,
  inputActor: ProjectManagementActor,
  fixture: DraftFixture,
  expectedLockVersion: number,
  options: {
    members?: Array<{ personId: string; role: TaskMemberRole }>;
  } = {},
) {
  if (name === "updateTaskDraft") {
    const planInput = await draftPlanReplaceInput(fixture, expectedLockVersion);
    const firstMilestone = planInput.milestones[0];
    if (!firstMilestone) throw new Error("缺少统一 Draft mutation Milestone");
    firstMilestone.goal = `${firstMilestone.goal}（统一 mutation）`;
    return updateTaskDraft(inputActor, {
      ...planInput,
      title: `S2 mutation ${name}`,
      description: "unified mutation matrix",
      team: "英雄",
      techGroup: "电控",
      priority: "HIGH",
      relatedTaskId: null,
      members: options.members ?? fixtureMembers(fixture),
    });
  }
  if (name === "updateActiveTask") {
    return updateActiveTask(inputActor, {
      taskId: fixture.taskId,
      expectedLockVersion,
      metadata: {
        title: `S2 mutation ${name}`,
        description: "mutation matrix",
        team: "英雄",
        techGroup: "电控",
        priority: "HIGH",
        relatedTaskId: null,
      },
      members: options.members ?? fixtureMembers(fixture),
    });
  }
  throw new Error(`未知 Task mutation：${name satisfies never}`);
}

export function fixtureMembers(fixture: DraftFixture) {
  return [
    { personId: fixture.owner.person.id, role: "OWNER" as const },
    { personId: fixture.reviewer.person.id, role: "PARTICIPANT" as const },
  ];
}

export async function draftPlanReplaceInput(
  fixture: DraftFixture,
  expectedLockVersion: number,
  options: {
    firstMilestoneNodeId?: string;
    firstMilestoneClientKey?: string;
  } = {},
) {
  const plan = await currentPlan(fixture.taskId);
  const milestones = plan.nodes.filter((entry) => entry.node.milestone);
  const termination = plan.nodes.at(-1);
  if (milestones.length === 0 || !termination?.node.termination) {
    throw new Error("缺少 Draft plan replace fixture");
  }
  return {
    taskId: fixture.taskId,
    planVersionId: fixture.currentPlanVersionId,
    expectedLockVersion,
    plannedStartAt: plan.plannedStartAt?.toISOString() ?? iso(2026, 8, 1),
    milestones: milestones.map((entry, index) => ({
      ...(index === 0 && options.firstMilestoneClientKey
        ? { clientKey: options.firstMilestoneClientKey }
        : {
            nodeId:
              index === 0 && options.firstMilestoneNodeId
                ? options.firstMilestoneNodeId
                : entry.nodeId,
          }),
      ...planMilestoneReplacementFields(entry),
    })),
    termination: planTerminationReplacement(termination),
  };
}

export async function updateDraftMetadataThroughCurrentInterface(
  inputActor: ProjectManagementActor,
  input: {
    taskId: string;
    expectedLockVersion: number;
    title: string;
    description: string;
    team: "英雄" | "工程";
    techGroup: "电控" | "机械";
    priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    relatedTaskId: string | null;
    projectId?: string | null;
  },
) {
  const task = await taskMutationSource(input.taskId);
  return updateTaskDraft(inputActor, {
    ...draftPlanInputFromPlan(input.taskId, task.currentPlanVersion),
    ...input,
  });
}

export function updateActiveMetadataThroughCurrentInterface(
  inputActor: ProjectManagementActor,
  input: {
    taskId: string;
    expectedLockVersion: number;
    title: string;
    description: string;
    team: "英雄" | "工程";
    techGroup: "电控" | "机械";
    priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    relatedTaskId: string | null;
    projectId?: string | null;
  },
) {
  const { taskId, expectedLockVersion, ...metadata } = input;
  return updateActiveTask(inputActor, { taskId, expectedLockVersion, metadata });
}

export async function updateTaskMembersThroughCurrentInterface(
  inputActor: ProjectManagementActor,
  input: {
    taskId: string;
    expectedLockVersion: number;
    members: Array<{ personId: string; role: TaskMemberRole }>;
  },
) {
  const task = await taskMutationSource(input.taskId);
  if (task.status === "ACTIVE") {
    return updateActiveTask(inputActor, input);
  }
  return updateTaskDraft(inputActor, {
    ...draftPlanInputFromPlan(input.taskId, task.currentPlanVersion),
    taskId: input.taskId,
    expectedLockVersion: input.expectedLockVersion,
    title: task.title,
    description: task.description,
    team: task.team,
    techGroup: task.techGroup,
    priority: task.priority,
    relatedTaskId: task.relatedTaskId,
    projectId: task.projectId,
    members: input.members,
  });
}

export async function updateDraftPlanThroughCurrentInterface(
  inputActor: ProjectManagementActor,
  input: DraftPlanMutationInput,
) {
  const task = await taskMutationSource(input.taskId);
  return updateTaskDraft(inputActor, {
    ...input,
    title: task.title,
    description: task.description,
    team: task.team,
    techGroup: task.techGroup,
    priority: task.priority,
    relatedTaskId: task.relatedTaskId,
    projectId: task.projectId,
  });
}

type DraftPlanMutationInput = {
  taskId: string;
  planVersionId: string;
  expectedLockVersion: number;
  plannedStartAt: string;
  milestones: Array<{
    nodeId?: string;
    clientKey?: string;
    goal: string;
    completionCriteria: string;
    expectedCompletedAt: string;
    reviewRequirements: string;
    businessDescription: string;
  }>;
  termination: {
    nodeId?: string;
    clientKey?: string;
    name: string;
    plannedOutcomeCriteria: string;
    plannedAt: string;
    businessDescription: string;
  };
};

async function taskMutationSource(taskId: string) {
  return prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: {
      currentPlanVersion: {
        include: {
          nodes: {
            include: {
              node: {
                include: { milestone: true, revision: true, termination: true },
              },
            },
            orderBy: { sequence: "asc" },
          },
        },
      },
    },
  });
}

function draftPlanInputFromPlan(
  taskId: string,
  plan: Awaited<ReturnType<typeof taskMutationSource>>["currentPlanVersion"],
) {
  const termination = plan.nodes.at(-1);
  if (!termination?.node.termination) throw new Error("Task 草稿缺少 Terminal");
  return {
    taskId,
    planVersionId: plan.id,
    expectedLockVersion: 0,
    plannedStartAt: plan.plannedStartAt?.toISOString() ?? iso(2026, 8, 1),
    milestones: plan.nodes.flatMap((entry) => entry.node.milestone
      ? [{ nodeId: entry.nodeId, ...planMilestoneReplacementFields(entry) }]
      : []),
    termination: planTerminationReplacement(termination),
  };
}

export function planMilestoneReplacement(entry: PlanEntryFixture) {
  return {
    nodeId: entry.nodeId,
    ...planMilestoneReplacementFields(entry),
  };
}

export function planMilestoneReplacementFields(entry: PlanEntryFixture) {
  if (!entry.node.milestone) throw new Error("计划节点不是 Milestone");
  return {
    goal: entry.node.milestone.goal,
    completionCriteria: entry.node.milestone.completionCriteria,
    expectedCompletedAt: entry.node.milestone.expectedCompletedAt.toISOString(),
    reviewRequirements: entry.node.milestone.reviewRequirements,
    businessDescription: entry.node.businessDescription,
  };
}

export function planTerminationReplacement(entry: PlanEntryFixture) {
  if (!entry.node.termination) throw new Error("计划节点不是 Termination");
  return {
    nodeId: entry.nodeId,
    name: entry.node.termination.name,
    plannedOutcomeCriteria: entry.node.termination.plannedOutcomeCriteria,
    plannedAt: entry.node.termination.plannedAt.toISOString(),
    businessDescription: entry.node.businessDescription,
  };
}

export async function createDraft(input: {
  creator: AccountPerson;
  owner: AccountPerson;
  reviewer: AccountPerson;
  title?: string;
  team?: "英雄" | "工程";
  techGroup?: "电控" | "机械";
  extraMembers?: Array<{ personId: string; role: TaskMemberRole }>;
}) {
  const created = await createTaskDraft(
    actor(input.creator),
    taskDraftInput({
      ownerPersonId: input.owner.person.id,
      reviewerPersonId: input.reviewer.person.id,
      title: input.title,
      team: input.team,
      techGroup: input.techGroup,
      extraMembers: input.extraMembers,
    }),
  );
  return { ...created, owner: input.owner, reviewer: input.reviewer };
}

export function taskDraftInput(input: {
  ownerPersonId: string;
  reviewerPersonId: string;
  title?: string;
  team?: "英雄" | "工程";
  techGroup?: "电控" | "机械";
  relatedTaskId?: string | null;
  extraMembers?: Array<{ personId: string; role: TaskMemberRole }>;
}) {
  return {
    title: input.title ?? `S2 Task ${randomUUID()}`,
    description: "S2 plan mutations regression",
    team: input.team ?? "英雄",
    techGroup: input.techGroup ?? "电控",
    priority: "HIGH" as const,
    members: [
      { personId: input.ownerPersonId, role: "OWNER" as const },
      { personId: input.reviewerPersonId, role: "PARTICIPANT" as const },
      ...(input.extraMembers ?? []),
    ],
    plannedStartAt: iso(2026, 8, 1),
    milestones: [
      milestoneInput("M1", 2),
      milestoneInput("M2", 4),
    ],
    termination: terminationInput(8),
    relatedTaskId: input.relatedTaskId ?? null,
    idempotencyKey: `s2-task-${randomUUID()}`,
  };
}

export function milestoneInput(goal: string, day: number) {
  return {
    goal,
    completionCriteria: `${goal} 完成条件`,
    expectedCompletedAt: iso(2026, 8, day),
    reviewRequirements: "提交文本证据",
    businessDescription: `${goal} 业务说明`,
  };
}

export function terminationInput(day: number) {
  return {
    name: "Terminal",
    plannedOutcomeCriteria: "完成全部目标",
    plannedAt: iso(2026, 8, day),
    businessDescription: "结束确认",
  };
}

export function iso(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day, 10, 0, 0)).toISOString();
}

export function uniqueWhitespaceOpenId(seed: string) {
  return [...seed.replaceAll("-", "")]
    .map((character) =>
      " ".repeat(Number.parseInt(character, 16) + 1),
    )
    .join("\t");
}

export async function createAccountPerson(displayName: string) {
  const openId = `ou_s2_plan_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: { create: { displayName, status: "ACTIVE" } },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { account, person: account.person, openId };
}

export async function grantRole(
  accountId: string,
  role: ProjectManagementSystemRole,
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team: "",
      techGroup: "",
      revokedAt: null,
    },
  });
}

export function actor(input: AccountPerson): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles: [],
  };
}

export async function currentTask(taskId: string) {
  return prisma.task.findUniqueOrThrow({ where: { id: taskId } });
}

export async function currentPlan(taskId: string) {
  return prisma.taskPlanVersion.findFirstOrThrow({
    where: { task: { id: taskId }, status: "CURRENT" },
    include: {
      nodes: {
        include: {
          node: {
            include: { milestone: true, revision: true, termination: true },
          },
        },
        orderBy: { sequence: "asc" },
      },
    },
  });
}

export async function planById(planVersionId: string) {
  return prisma.taskPlanVersion.findUniqueOrThrow({
    where: { id: planVersionId },
    include: {
      nodes: {
        include: {
          node: {
            include: { milestone: true, revision: true, termination: true },
          },
        },
        orderBy: { sequence: "asc" },
      },
    },
  });
}

export type SegmentReferenceFixture = {
  taskId: string;
  personId: string;
  accountId: string;
};

export async function createSegmentReference(
  input: SegmentReferenceFixture & {
    type: WorkSegmentType;
    status: WorkSegmentStatus;
    deletedAt?: Date;
  },
) {
  await prisma.workSegment.create({
    data: {
      personId: input.personId,
      type: input.type,
      status: input.status,
      startAt: new Date("2026-08-02T09:00:00.000Z"),
      endAt: new Date("2026-08-02T10:00:00.000Z"),
      content: `S2 reference ${input.type}/${input.status}`,
      taskId: input.taskId,
      deletedAt: input.deletedAt,
      createdByAccountId: input.accountId,
    },
  });
}

export async function mutationSideEffectCounts(taskId: string) {
  const task = await currentTask(taskId);
  const plan = await currentPlan(taskId);
  return {
    lockVersion: task.lockVersion,
    updatedAt: task.updatedAt.toISOString(),
    taskMetadata: {
      title: task.title,
      description: task.description,
      team: task.team,
      techGroup: task.techGroup,
      priority: task.priority,
      relatedTaskId: task.relatedTaskId,
      status: task.status,
    },
    memberRows: (
      await prisma.taskMember.findMany({
        where: { taskId },
        orderBy: { id: "asc" },
      })
    ).map((member) => ({
      id: member.id,
      personId: member.personId,
      role: member.role,
      removedAt: member.removedAt?.toISOString() ?? null,
      createdByAccountId: member.createdByAccountId,
      createdAt: member.createdAt.toISOString(),
    })),
    planUpdatedAt: plan.updatedAt.toISOString(),
    plannedStartAt: plan.plannedStartAt?.toISOString() ?? null,
    snapshotHash: plan.snapshotHash,
    planNodeCount: plan.nodes.length,
    nodeContent: plan.nodes.map((entry) => ({
      nodeId: entry.nodeId,
      sequence: entry.sequence,
      isCarryForward: entry.isCarryForward,
      type: entry.node.type,
      status: entry.node.status,
      deletedAt: entry.node.deletedAt?.toISOString() ?? null,
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
      termination: entry.node.termination
        ? {
            name: entry.node.termination.name,
            plannedOutcomeCriteria:
              entry.node.termination.plannedOutcomeCriteria,
            plannedAt: entry.node.termination.plannedAt.toISOString(),
          }
        : null,
    })),
    taskNodeRows: await prisma.taskNode.findMany({
      where: { taskId },
      select: {
        id: true,
        type: true,
        status: true,
        businessDescription: true,
        deletedAt: true,
      },
      orderBy: { id: "asc" },
    }),
    auditCount: await prisma.domainAuditEvent.count({ where: { taskId } }),
    auditRows: await prisma.domainAuditEvent.findMany({
      where: { taskId },
      select: { id: true, action: true, before: true, after: true, reason: true },
      orderBy: { id: "asc" },
    }),
    notificationRows: await prisma.inAppNotification.findMany({
      where: { taskId },
      select: {
        id: true,
        eventKey: true,
        recipientAccountId: true,
        payload: true,
      },
      orderBy: { id: "asc" },
    }),
    outboxRows: await prisma.notificationOutbox.findMany({
      where: { eventKey: { contains: taskId } },
      select: { id: true, eventKey: true, payload: true, status: true },
      orderBy: { id: "asc" },
    }),
  };
}

export async function relatedTaskReferenceSideEffectSnapshot(
  taskIds: readonly string[],
  includeGlobalCounts: boolean,
) {
  const normalizedTaskIds = [...new Set(taskIds)].sort();
  const outboxWhere = {
    OR: normalizedTaskIds.map((taskId) => ({
      eventKey: { contains: taskId },
    })),
  };
  const [
    tasks,
    planVersions,
    planVersionNodes,
    taskNodes,
    taskMembers,
    auditEvents,
    inAppNotifications,
    notificationOutboxes,
    globalCounts,
  ] = await Promise.all([
    prisma.task.findMany({
      where: { id: { in: normalizedTaskIds } },
      orderBy: { id: "asc" },
    }),
    prisma.taskPlanVersion.findMany({
      where: { taskId: { in: normalizedTaskIds } },
      orderBy: { id: "asc" },
    }),
    prisma.planVersionNode.findMany({
      where: { planVersion: { taskId: { in: normalizedTaskIds } } },
      orderBy: { id: "asc" },
    }),
    prisma.taskNode.findMany({
      where: { taskId: { in: normalizedTaskIds } },
      include: {
        milestone: true,
        revision: true,
        termination: true,
      },
      orderBy: { id: "asc" },
    }),
    prisma.taskMember.findMany({
      where: { taskId: { in: normalizedTaskIds } },
      orderBy: { id: "asc" },
    }),
    prisma.domainAuditEvent.findMany({
      where: { taskId: { in: normalizedTaskIds } },
      orderBy: { id: "asc" },
    }),
    prisma.inAppNotification.findMany({
      where: { taskId: { in: normalizedTaskIds } },
      orderBy: { id: "asc" },
    }),
    prisma.notificationOutbox.findMany({
      where: outboxWhere,
      include: { recipients: { orderBy: { id: "asc" } } },
      orderBy: { id: "asc" },
    }),
    includeGlobalCounts
      ? relatedTaskReferenceGlobalCounts()
      : Promise.resolve(undefined),
  ]);

  return {
    tasks,
    planVersions,
    planVersionNodes,
    taskNodes,
    taskMembers,
    auditEvents,
    inAppNotifications,
    notificationOutboxes,
    globalCounts,
  };
}

export async function relatedTaskReferenceGlobalCounts() {
  const [
    tasks,
    planVersions,
    planVersionNodes,
    taskNodes,
    milestoneNodes,
    revisionNodes,
    terminationNodes,
    taskMembers,
    auditEvents,
    inAppNotifications,
    notificationOutboxes,
    notificationOutboxRecipients,
  ] = await Promise.all([
    prisma.task.count(),
    prisma.taskPlanVersion.count(),
    prisma.planVersionNode.count(),
    prisma.taskNode.count(),
    prisma.milestoneNode.count(),
    prisma.revisionNode.count(),
    prisma.terminationNode.count(),
    prisma.taskMember.count(),
    prisma.domainAuditEvent.count(),
    prisma.inAppNotification.count(),
    prisma.notificationOutbox.count(),
    prisma.notificationOutboxRecipient.count(),
  ]);
  return {
    tasks,
    planVersions,
    planVersionNodes,
    taskNodes,
    milestoneNodes,
    revisionNodes,
    terminationNodes,
    taskMembers,
    auditEvents,
    inAppNotifications,
    notificationOutboxes,
    notificationOutboxRecipients,
  };
}

export type MutationSideEffectSnapshot = Awaited<
  ReturnType<typeof mutationSideEffectCounts>
>;

export function expectMutationBusinessEffect(
  name: MutationActionName,
  before: MutationSideEffectSnapshot,
  after: MutationSideEffectSnapshot,
) {
  if (name === "updateTaskDraft") {
    expect(after.taskMetadata).not.toEqual(before.taskMetadata);
    expect(after.nodeContent).not.toEqual(before.nodeContent);
    return;
  }
  if (name === "updateActiveTask") {
    expect(after.taskMetadata).not.toEqual(before.taskMetadata);
    expect(after.memberRows).not.toEqual(before.memberRows);
    return;
  }
  throw new Error(`未覆盖 Task mutation：${name satisfies never}`);
}

export async function segmentAssociationSideEffectSnapshot(segmentIds: string[]) {
  return {
    segmentCount: await prisma.workSegment.count(),
    changeCount: await prisma.workSegmentChange.count(),
    sourceCount: await prisma.workSegmentSource.count(),
    auditCount: await prisma.domainAuditEvent.count(),
    notificationCount: await prisma.inAppNotification.count(),
    outboxCount: await prisma.notificationOutbox.count(),
    segments: await prisma.workSegment.findMany({
      where: { id: { in: segmentIds } },
      orderBy: { id: "asc" },
    }),
    changes: await prisma.workSegmentChange.findMany({
      where: { segmentId: { in: segmentIds } },
      orderBy: { id: "asc" },
    }),
  };
}

export function segmentCreateInput(personId: string, content: string, hour = 1) {
  return {
    personId,
    startAt: new Date(Date.UTC(2026, 7, 20, hour, 0, 0)),
    endAt: new Date(Date.UTC(2026, 7, 20, hour + 1, 0, 0)),
    content,
    priority: "MEDIUM" as const,
  };
}

export async function expectServiceError(
  promise: Promise<unknown>,
  expectedCode: ReturnType<typeof toProjectManagementServiceError>["code"],
  options?: { expectedCurrentLockVersion?: number },
) {
  try {
    await promise;
  } catch (error) {
    const mapped = toProjectManagementServiceError(error);
    expect(mapped.code).toBe(expectedCode);
    if (options?.expectedCurrentLockVersion !== undefined) {
      expect(mapped.current).toMatchObject({
        kind: "TASK",
        lockVersion: options.expectedCurrentLockVersion,
      });
    }
    return mapped;
  }
  throw new Error(`测试期望 ${expectedCode}，但操作成功`);
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("测试期望 JSON object");
}

export async function approveCurrentMilestone(
  taskId: string,
  owner: AccountPerson,
  reviewer: AccountPerson,
  suffix: string,
) {
  const current = await currentPlan(taskId);
  const milestone = current.nodes.find(
    (entry) => entry.node.type === "MILESTONE" && entry.node.status === "ACTIVE",
  );
  if (!milestone) throw new Error("缺少 Active Milestone");
  const review = await submitMilestoneForReview(actor(owner), {
    milestoneNodeId: milestone.nodeId,
    idempotencyKey: `s2-${suffix}-${randomUUID()}`,
    evidences: [{ kind: "TEXT", note: `完成 ${suffix}` }],
  });
  await reviewMilestone(actor(reviewer), {
    reviewId: review.reviewId,
    result: "APPROVED",
    comment: `通过 ${suffix}`,
  });
}

export function serviceOutcomeCodes(outcomes: PromiseSettledResult<unknown>[]) {
  return outcomes
    .map((outcome) =>
      outcome.status === "fulfilled"
        ? "OK"
        : toProjectManagementServiceError(outcome.reason).code,
    )
    .sort();
}

export async function installControlledAuditFailureTrigger() {
  await removeControlledAuditFailureTrigger();
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "test_s2_controlled_audit_failure"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 's2 controlled late audit failure';
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "test_s2_controlled_audit_failure"
    BEFORE INSERT ON "DomainAuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "test_s2_controlled_audit_failure"()
  `);
}

export async function removeControlledAuditFailureTrigger() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS "test_s2_controlled_audit_failure"
    ON "DomainAuditEvent"
  `);
  await prisma.$executeRawUnsafe(`
    DROP FUNCTION IF EXISTS "test_s2_controlled_audit_failure"()
  `);
}

export async function installControlledMemberOutboxFailureTrigger() {
  await removeControlledMemberOutboxFailureTrigger();
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "test_s2_controlled_member_outbox_failure"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW."eventKey" LIKE 'pm:task:member_changed:%' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM "InAppNotification"
          WHERE "eventKey" LIKE
            replace(NEW."eventKey", ':feishu', '') || ':inapp:%'
        ) THEN
          RAISE EXCEPTION 's2 inapp was not written before outbox';
        END IF;
        RAISE EXCEPTION 's2 controlled outbox failure after inapp';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER "test_s2_controlled_member_outbox_failure"
    BEFORE INSERT ON "NotificationOutbox"
    FOR EACH ROW
    EXECUTE FUNCTION "test_s2_controlled_member_outbox_failure"()
  `);
}

export async function removeControlledMemberOutboxFailureTrigger() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS "test_s2_controlled_member_outbox_failure"
    ON "NotificationOutbox"
  `);
  await prisma.$executeRawUnsafe(`
    DROP FUNCTION IF EXISTS "test_s2_controlled_member_outbox_failure"()
  `);
}

export async function runBehindTaskLockBarrier(
  taskId: string,
  operations: [() => Promise<unknown>, () => Promise<unknown>],
) {
  return runTaskLockBarrier(taskId, operations, false);
}

export async function runTaskAssociationLockChain(
  taskId: string,
  firstOperation: () => Promise<unknown>,
  secondOperation: () => Promise<unknown>,
) {
  return runTaskLockBarrier(
    taskId,
    [firstOperation, secondOperation],
    true,
  );
}

export async function runTaskLockBarrier(
  taskId: string,
  operations: [() => Promise<unknown>, () => Promise<unknown>],
  ordered: boolean,
) {
  let locker: Client | undefined;
  let observer: Client | undefined;
  let transactionMayBeOpen = false;
  let released = false;
  let pending: Promise<unknown>[] = [];
  let pendingSettlement: Promise<PromiseSettledResult<unknown>[]> | undefined;
  let pendingBackendPids: number[] = [];
  let pendingHandled = false;
  let result: PromiseSettledResult<unknown>[] | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    locker = await connectDatabaseClient("s2-task-locker");
    observer = await connectDatabaseClient("s2-task-observer");
    transactionMayBeOpen = true;
    const lockerPid = await lockTaskRow(locker, taskId);
    if (ordered) {
      const first = startBarrierOperations([operations[0]]).pending[0];
      if (!first) throw new Error("首个 Task lock operation 未启动");
      pending.push(first);
      await waitForTaskLockBlockers(observer, lockerPid, 1);
      const second = startBarrierOperations([operations[1]]).pending[0];
      if (!second) throw new Error("第二个 Task lock operation 未启动");
      pending.push(second);
    } else {
      pending = startBarrierOperations(operations).pending;
    }
    pendingSettlement = Promise.allSettled(pending);
    pendingBackendPids = await waitForTaskLockBlockers(observer, lockerPid, 2);
    if (new Set(pendingBackendPids).size < 2) {
      throw new Error("两个 Task mutation 未使用独立 PostgreSQL backend");
    }
    await locker.query("COMMIT");
    released = true;
    result = await pendingSettlement;
    pendingHandled = true;
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }
  const cleanupErrors = await cleanupBarrierResources({
    locker,
    observer,
    rollbackRequired: Boolean(locker && transactionMayBeOpen && !released),
    pendingSettlement,
    pendingBackendPids,
    pendingHandled,
    primaryError,
  });
  throwBarrierErrors(hasPrimaryError, primaryError, cleanupErrors);
  if (!result) throw new Error("Task lock barrier 未返回结果");
  return result;
}

export async function lockTaskRow(client: Client, taskId: string) {
  await client.query("BEGIN");
  const identity = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = identity.rows[0]?.pid;
  if (!pid) throw new Error("无法取得 Task locker backend pid");
  await client.query('SELECT "id" FROM "Task" WHERE "id" = $1 FOR UPDATE', [
    taskId,
  ]);
  return pid;
}

export async function waitForTaskLockBlockers(
  observer: Client,
  blockerPid: number,
  expectedCount: number,
) {
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    const result = await observer.query<{ pid: number }>(
      `WITH RECURSIVE "blocked"("pid") AS (
         SELECT "activity"."pid"
         FROM "pg_stat_activity" AS "activity"
         WHERE $1::int = ANY(pg_blocking_pids("activity"."pid"))
         UNION
         SELECT "activity"."pid"
         FROM "pg_stat_activity" AS "activity"
         JOIN "blocked" AS "blocker"
           ON "blocker"."pid" = ANY(pg_blocking_pids("activity"."pid"))
       )
       SELECT "pid" FROM "blocked" ORDER BY "pid" ASC`,
      [blockerPid],
    );
    const pids = [...new Set(result.rows.map((row) => row.pid))];
    if (pids.length >= expectedCount) return pids;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`未观察到 ${expectedCount} 个 Task lock waiter`);
}
