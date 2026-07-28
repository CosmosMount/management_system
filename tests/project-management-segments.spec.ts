import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { TaskMemberRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  createTaskDraft,
} from "../lib/project-management/application/lifecycle-service";
import {
  batchCreatePlannedSegments,
  cancelPlannedSegment,
  confirmPlannedSegment,
  createActualSegment,
  createWorkSegment,
  mergePlannedSegments,
  movePlannedSegments,
  partiallyConfirmSegment,
  relinkPlannedSegment,
  scanSegmentTransitions,
  softDeleteActualSegment,
  splitPlannedSegment,
  updateWorkSegment,
} from "../lib/project-management/application/segment-service";
import {
  toProjectManagementServiceError,
} from "../lib/project-management/application/errors";
import {
  getWorkSegment,
  listWorkSegmentChanges,
  listWorkSegments,
} from "../lib/project-management/queries/resource-queries";
import type {
  ProjectManagementActor,
  ProjectManagementSystemRoleRecord,
} from "../lib/project-management/identity";

test.describe("project management P5 work segment services", () => {
  test("Segment validation, permissions, batch rollback and optimistic lock are enforced", async () => {
    const fixture = await createActivatedFixture();

    await expectServiceError(
      createWorkSegment(actor(fixture.member), {
        personId: fixture.member.person.id,
        type: "PLANNED",
        startAt: atHour(10),
        endAt: atHour(9),
        content: "非法时间",
        allocation: 50,
      }),
      "VALIDATION_ERROR",
    );

    await expectServiceError(
      createWorkSegment(actor(fixture.outsider), {
        personId: fixture.member.person.id,
        type: "PLANNED",
        startAt: atHour(9),
        endAt: atHour(10),
        content: "越权创建他人计划",
        allocation: 50,
      }),
      "FORBIDDEN",
    );

    const selfSegment = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    expect(selfSegment.segment.status).toBe("PLANNED");

    const managerSegment = await createWorkSegment(actor(fixture.resourceManager), {
      ...plannedInput(fixture.member.person.id, 10, 11),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    expect(managerSegment.segment.personId).toBe(fixture.member.person.id);

    const otherScope = await createActivatedFixture({
      team: "工程",
      techGroup: "机械",
      extraMembers: [{ personId: fixture.resourceManager.person.id, role: "VIEWER" }],
    });
    const relinkCandidate = await createWorkSegment(actor(fixture.resourceManager), {
      ...plannedInput(fixture.member.person.id, 13, 14),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await prisma.workSegment.update({
      where: { id: relinkCandidate.segment.id },
      data: { associationNeedsReview: true },
    });
    const relinkCandidateVersion = await prisma.workSegment.findUniqueOrThrow({
      where: { id: relinkCandidate.segment.id },
      select: { updatedAt: true },
    });
    await expectServiceError(
      relinkPlannedSegment(actor(fixture.resourceManager), {
        segmentId: relinkCandidate.segment.id,
        expectedUpdatedAt: relinkCandidateVersion.updatedAt,
        taskId: otherScope.taskId,
        nodeId: null,
        reason: "不能只凭目标 Task 可见性重关联他人 Segment",
      }),
      "NOT_FOUND",
    );

    await expectServiceError(
      createWorkSegment(actor(fixture.outsider), {
        ...plannedInput(fixture.outsider.person.id, 11, 12),
        taskId: fixture.taskId,
        nodeId: fixture.activeNodeId,
      }),
      "NOT_FOUND",
    );

    const updated = await updateWorkSegment(actor(fixture.member), {
      segmentId: selfSegment.segment.id,
      expectedUpdatedAt: selfSegment.segment.updatedAt,
      content: "更新后的计划内容",
      allocation: 60,
      reason: "调整投入",
    });
    expect(updated.segment.content).toBe("更新后的计划内容");
    await expectServiceError(
      updateWorkSegment(actor(fixture.member), {
        segmentId: selfSegment.segment.id,
        expectedUpdatedAt: selfSegment.segment.updatedAt,
        content: "过期更新",
      }),
      "STATE_CONFLICT",
    );

    const beforeBatchCount = await prisma.workSegment.count();
    await expectServiceError(
      batchCreatePlannedSegments(actor(fixture.resourceManager), {
        segments: [
          {
            ...plannedInput(fixture.member.person.id, 12, 13),
            taskId: fixture.taskId,
            nodeId: fixture.activeNodeId,
          },
          {
            ...plannedInput(fixture.disabledPerson.id, 13, 14),
            taskId: fixture.taskId,
            nodeId: fixture.activeNodeId,
          },
        ],
      }),
      "VALIDATION_ERROR",
    );
    expect(await prisma.workSegment.count()).toBe(beforeBatchCount);

    const visibleToMember = await listWorkSegments({
      actor: actor(fixture.member),
      input: { taskId: fixture.taskId },
    });
    expect(visibleToMember.items.map((item) => item.id)).toContain(
      selfSegment.segment.id,
    );
    await expectServiceError(
      getWorkSegment({
        actor: actor(fixture.outsider),
        input: { segmentId: selfSegment.segment.id },
      }),
      "NOT_FOUND",
    );
  });

  test("Planned Segment split and merge preserve coverage, history and tags", async () => {
    const fixture = await createActivatedFixture();
    const tag = await prisma.tag.create({
      data: {
        name: `P5-Segment-Tag-${randomUUID()}`,
        color: "#2563eb",
        createdByAccountId: fixture.owner.account.id,
      },
    });
    const planned = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 11),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
      tagIds: [tag.id],
    });

    await expectServiceError(
      splitPlannedSegment(actor(fixture.member), {
        segmentId: planned.segment.id,
        expectedUpdatedAt: planned.segment.updatedAt,
        reason: "错误拆分",
        parts: [
          { startAt: atHour(9), endAt: atHour(9.5) },
          { startAt: atHour(10), endAt: atHour(11) },
        ],
      }),
      "VALIDATION_ERROR",
    );

    const split = await splitPlannedSegment(actor(fixture.member), {
      segmentId: planned.segment.id,
      expectedUpdatedAt: planned.segment.updatedAt,
      reason: "按上午两段拆分",
      parts: [
        { startAt: atHour(9), endAt: atHour(10) },
        { startAt: atHour(10), endAt: atHour(11) },
      ],
    });
    expect(split.segments).toHaveLength(2);
    expect(split.segments.map((segment) => segment.sourceSplitFromId)).toEqual([
      planned.segment.id,
      planned.segment.id,
    ]);
    expect(split.segments.flatMap((segment) => segment.tagIds)).toEqual([
      tag.id,
      tag.id,
    ]);
    const originalAfterSplit = await prisma.workSegment.findUniqueOrThrow({
      where: { id: planned.segment.id },
      select: { status: true },
    });
    expect(originalAfterSplit.status).toBe("CANCELLED");
    const secondSplit = split.segments[1];
    if (!secondSplit) throw new Error("缺少第二段拆分结果");
    const inProgressChild = await prisma.workSegment.update({
      where: { id: secondSplit.id },
      data: { status: "IN_PROGRESS" },
      select: { id: true, updatedAt: true },
    });

    const merged = await mergePlannedSegments(actor(fixture.member), {
      segments: split.segments.map((segment) =>
        segment.id === inProgressChild.id
          ? {
              segmentId: segment.id,
              expectedUpdatedAt: inProgressChild.updatedAt,
            }
          : {
              segmentId: segment.id,
              expectedUpdatedAt: segment.updatedAt,
            },
      ),
      reason: "恢复为连续计划",
    });
    expect(merged.segment.startAt).toBe(atHour(9).toISOString());
    expect(merged.segment.endAt).toBe(atHour(11).toISOString());
    expect(merged.segment.tagIds).toEqual([tag.id]);
    const changeHistory = await listWorkSegmentChanges({
      actor: actor(fixture.member),
      input: { segmentId: merged.segment.id },
    });
    expect(changeHistory.items.map((item) => item.action)).toContain("MERGE");
  });

  test("Confirm, partial confirm and Actual sources preserve Planned/Actual relationships", async () => {
    const fixture = await createActivatedFixture();
    const planned = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
      expectedOutput: "完成计划产出",
    });
    const confirmed = await confirmPlannedSegment(actor(fixture.member), {
      segmentId: planned.segment.id,
      expectedUpdatedAt: planned.segment.updatedAt,
      actual: { actualOutput: "实际完成" },
    });
    expect(confirmed.segment.status).toBe("CONFIRMED");
    expect(confirmed.actualSegment.type).toBe("ACTUAL");
    const source = await prisma.workSegmentSource.findFirstOrThrow({
      where: {
        plannedSegmentId: planned.segment.id,
        actualSegmentId: confirmed.actualSegment.id,
      },
    });
    expect(source.coveredStartAt.toISOString()).toBe(planned.segment.startAt);
    await expectServiceError(
      updateWorkSegment(actor(fixture.member), {
        segmentId: planned.segment.id,
        expectedUpdatedAt: confirmed.segment.updatedAt,
        content: "试图修改已确认计划",
      }),
      "STATE_CONFLICT",
    );
    const repeated = await confirmPlannedSegment(actor(fixture.member), {
      segmentId: planned.segment.id,
      expectedUpdatedAt: confirmed.segment.updatedAt,
    });
    expect(repeated.createdActual).toBe(false);
    expect(repeated.actualSegment.id).toBe(confirmed.actualSegment.id);

    const partialPlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 11, 13),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await expectServiceError(
      partiallyConfirmSegment(actor(fixture.member), {
        segmentId: partialPlan.segment.id,
        expectedUpdatedAt: partialPlan.segment.updatedAt,
        coveredStartAt: atHour(11),
        coveredEndAt: atHour(13),
      }),
      "VALIDATION_ERROR",
    );
    const partial = await partiallyConfirmSegment(actor(fixture.member), {
      segmentId: partialPlan.segment.id,
      expectedUpdatedAt: partialPlan.segment.updatedAt,
      coveredStartAt: atHour(11.5),
      coveredEndAt: atHour(12.5),
      actual: { content: "实际只完成中间部分" },
    });
    expect(partial.segment.status).toBe("CANCELLED");
    expect(partial.remainingSegments).toHaveLength(2);

    const planA = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 14, 15),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const planB = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 15, 16),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const actualWithSources = await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(14),
      endAt: atHour(16),
      content: "一次实际投入覆盖两条计划",
      allocation: 80,
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
      sources: [
        {
          plannedSegmentId: planA.segment.id,
          coveredStartAt: atHour(14),
          coveredEndAt: atHour(15),
        },
        {
          plannedSegmentId: planB.segment.id,
          coveredStartAt: atHour(15),
          coveredEndAt: atHour(16),
        },
      ],
    });
    expect(
      await prisma.workSegmentSource.count({
        where: { actualSegmentId: actualWithSources.segment.id },
      }),
    ).toBe(2);

    const unplannedActual = await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(17),
      endAt: atHour(18),
      content: "未提前规划的实际投入",
      allocation: 30,
    });
    expect(unplannedActual.segment.type).toBe("ACTUAL");

    const sourceLeakPlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 18, 19),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(18),
      endAt: atHour(19),
      content: "无 Task 的来源 Actual",
      allocation: 40,
      sources: [
        {
          plannedSegmentId: sourceLeakPlan.segment.id,
          coveredStartAt: atHour(18),
          coveredEndAt: atHour(19),
        },
      ],
    });
    const ownerView = await getWorkSegment({
      actor: actor(fixture.owner),
      input: { segmentId: sourceLeakPlan.segment.id },
    });
    expect(ownerView.plannedSources).toHaveLength(0);
    const memberView = await getWorkSegment({
      actor: actor(fixture.member),
      input: { segmentId: sourceLeakPlan.segment.id },
    });
    expect(memberView.plannedSources).toHaveLength(1);
  });

  test("Cancel, relink and soft-delete do not advance Task or Milestone state", async () => {
    const fixture = await createActivatedFixture();
    const planned = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const nextNode = await nextCurrentMilestone(fixture.taskId, fixture.activeNodeId);
    await prisma.workSegment.update({
      where: { id: planned.segment.id },
      data: { associationNeedsReview: true },
    });
    const staleForRelink = await prisma.workSegment.findUniqueOrThrow({
      where: { id: planned.segment.id },
      select: { updatedAt: true },
    });
    const taskBefore = await taskState(fixture.taskId);
    const relinked = await relinkPlannedSegment(actor(fixture.member), {
      segmentId: planned.segment.id,
      expectedUpdatedAt: staleForRelink.updatedAt,
      taskId: fixture.taskId,
      nodeId: nextNode.nodeId,
      reason: "Revision 后人工重关联",
    });
    expect(relinked.segment.associationNeedsReview).toBe(false);
    expect(relinked.segment.nodeId).toBe(nextNode.nodeId);

    const cancelledPlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10, 11),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const cancelled = await cancelPlannedSegment(actor(fixture.member), {
      segmentId: cancelledPlan.segment.id,
      expectedUpdatedAt: cancelledPlan.segment.updatedAt,
      reason: "不再安排",
    });
    expect(cancelled.segment.status).toBe("CANCELLED");

    const actual = await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(11),
      endAt: atHour(12),
      content: "需要删除的实际投入",
      allocation: 20,
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const deleted = await softDeleteActualSegment(actor(fixture.member), {
      segmentId: actual.segment.id,
      expectedUpdatedAt: actual.segment.updatedAt,
      reason: "误填",
    });
    expect(deleted.segment.deletedAt).not.toBeNull();
    expect(await taskState(fixture.taskId)).toEqual(taskBefore);
  });

  test("Moving Planned Segment is all-or-nothing", async () => {
    const fixture = await createActivatedFixture();
    const first = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const second = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10, 11),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await updateWorkSegment(actor(fixture.member), {
      segmentId: second.segment.id,
      expectedUpdatedAt: second.segment.updatedAt,
      content: "先改一次制造版本冲突",
    });
    await expectServiceError(
      movePlannedSegments(actor(fixture.member), {
        moves: [
          {
            segmentId: first.segment.id,
            expectedUpdatedAt: first.segment.updatedAt,
            startAt: atHour(12),
            endAt: atHour(13),
          },
          {
            segmentId: second.segment.id,
            expectedUpdatedAt: second.segment.updatedAt,
            startAt: atHour(13),
            endAt: atHour(14),
          },
        ],
        reason: "批量移动",
      }),
      "STATE_CONFLICT",
    );
    const firstAfter = await prisma.workSegment.findUniqueOrThrow({
      where: { id: first.segment.id },
      select: { startAt: true, endAt: true },
    });
    expect(firstAfter.startAt.toISOString()).toBe(first.segment.startAt);
  });

  test("Segment transition scan writes change history and audit", async () => {
    const fixture = await createActivatedFixture();
    const inProgressPlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 11),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const duePlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 7, 8),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });

    const result = await scanSegmentTransitions(atHour(10));
    expect(result.inProgressCount).toBeGreaterThanOrEqual(1);
    expect(result.pendingConfirmationCount).toBeGreaterThanOrEqual(1);

    const transitioned = await prisma.workSegment.findMany({
      where: { id: { in: [inProgressPlan.segment.id, duePlan.segment.id] } },
      select: { id: true, status: true },
    });
    expect(new Map(transitioned.map((segment) => [segment.id, segment.status]))).toEqual(
      new Map([
        [inProgressPlan.segment.id, "IN_PROGRESS"],
        [duePlan.segment.id, "PENDING_CONFIRMATION"],
      ]),
    );
    await expectSegmentChange(inProgressPlan.segment.id, "Planned Segment 已开始");
    await expectSegmentChange(duePlan.segment.id, "Planned Segment 已到期，等待确认");
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "WorkSegment",
          entityId: { in: [inProgressPlan.segment.id, duePlan.segment.id] },
          action: "pm.segment.update",
          source: "CRON",
        },
      }),
    ).toBe(2);
  });
});

async function createActivatedFixture(
  options: {
    team?: string;
    techGroup?: string;
    extraMembers?: Array<{ personId: string; role: TaskMemberRole }>;
  } = {},
) {
  const team = options.team ?? "英雄";
  const techGroup = options.techGroup ?? "电控";
  const admin = await createAccountPerson("P5 Team Admin");
  const owner = await createAccountPerson("P5 Owner");
  const member = await createAccountPerson("P5 Member");
  const reviewer = await createAccountPerson("P5 Reviewer");
  const outsider = await createAccountPerson("P5 Outsider");
  const resourceManager = await createAccountPerson("P5 Resource Manager");
  const disabledPerson = await prisma.person.create({
    data: { displayName: "P5 Disabled Person", status: "INACTIVE" },
  });
  await grantRole(admin.account.id, "TEAM_ADMINISTRATOR", {
    team,
    techGroup,
  });
  await grantRole(resourceManager.account.id, "RESOURCE_MANAGER", {
    team,
    techGroup,
  });
  const draft = await createTaskDraft(actor(admin), {
    title: `P5 Segment Task ${randomUUID()}`,
    description: "P5 Segment 测试",
    team,
    techGroup,
    priority: "HIGH",
    tagIds: [],
    members: [
      { personId: owner.person.id, role: "OWNER" },
      { personId: member.person.id, role: "MEMBER" },
      { personId: reviewer.person.id, role: "REVIEWER" },
      ...(options.extraMembers ?? []),
    ],
    milestones: [
      milestoneInput("阶段一", "完成阶段一", 1),
      milestoneInput("阶段二", "完成阶段二", 2),
    ],
    termination: terminationInput(5),
    idempotencyKey: `p5-segment-task-${randomUUID()}`,
  });
  const activated = await activateTask(actor(owner), {
    taskId: draft.taskId,
    expectedLockVersion: draft.lockVersion,
  });
  const activeNode = await currentActiveMilestone(draft.taskId);
  return {
    admin,
    owner,
    member,
    reviewer,
    outsider,
    resourceManager,
    disabledPerson,
    taskId: draft.taskId,
    currentPlanVersionId: activated.currentPlanVersionId,
    activeNodeId: activeNode.nodeId,
  };
}

function plannedInput(personId: string, startHour: number, endHour: number) {
  return {
    personId,
    type: "PLANNED",
    startAt: atHour(startHour),
    endAt: atHour(endHour),
    content: `计划投入 ${startHour}-${endHour}`,
    allocation: 50,
    role: "DEVELOPER",
    priority: "MEDIUM",
    tagIds: [],
  };
}

function milestoneInput(goal: string, criteria: string, daysFromBase: number) {
  return {
    goal,
    completionCriteria: criteria,
    expectedCompletedAt: new Date(Date.UTC(2026, 7, daysFromBase, 10, 0, 0)),
    reviewRequirements: "提交文本或链接证据",
    businessDescription: goal,
  };
}

function terminationInput(daysFromBase: number) {
  return {
    plannedOutcomeCriteria: "所有 Milestone 完成并完成总结",
    plannedAt: new Date(Date.UTC(2026, 7, daysFromBase, 10, 0, 0)),
    businessDescription: "结束确认",
  };
}

async function currentActiveMilestone(taskId: string) {
  const row = await prisma.planVersionNode.findFirstOrThrow({
    where: {
      planVersion: { taskId, status: "CURRENT" },
      node: { type: "MILESTONE", status: "ACTIVE" },
    },
    select: { nodeId: true },
  });
  return row;
}

async function nextCurrentMilestone(taskId: string, activeNodeId: string) {
  const row = await prisma.planVersionNode.findFirstOrThrow({
    where: {
      planVersion: { taskId, status: "CURRENT" },
      node: {
        type: "MILESTONE",
        id: { not: activeNodeId },
      },
    },
    select: { nodeId: true },
    orderBy: { sequence: "asc" },
  });
  return row;
}

async function taskState(taskId: string) {
  return prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      status: true,
      activeMilestoneNodeId: true,
      lockVersion: true,
      currentPlanVersionId: true,
    },
  });
}

async function createAccountPerson(displayName: string) {
  const openId = `ou_pm_p5_segment_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      status: "ACTIVE",
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: {
        create: {
          displayName,
          status: "ACTIVE",
        },
      },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { account, person: account.person, openId };
}

async function grantRole(
  accountId: string,
  role: "TEAM_ADMINISTRATOR" | "RESOURCE_MANAGER" | "SYSTEM_ADMINISTRATOR",
  scope: { team?: string; techGroup?: string } = {},
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team: scope.team ?? "",
      techGroup: scope.techGroup ?? "",
    },
  });
}

function actor(
  input: Awaited<ReturnType<typeof createAccountPerson>>,
  systemRoles: ProjectManagementSystemRoleRecord[] = [],
): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles,
  };
}

function atHour(hour: number) {
  const fullHour = Math.trunc(hour);
  const minutes = Math.round((hour - fullHour) * 60);
  return new Date(Date.UTC(2026, 7, 10, fullHour, minutes, 0));
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: ReturnType<typeof toProjectManagementServiceError>["code"],
) {
  await expect(
    promise.catch((error) => toProjectManagementServiceError(error).code),
  ).resolves.toBe(code);
}

async function expectSegmentChange(segmentId: string, reason: string) {
  await prisma.workSegmentChange.findFirstOrThrow({
    where: { segmentId, action: "UPDATE", reason },
  });
}
