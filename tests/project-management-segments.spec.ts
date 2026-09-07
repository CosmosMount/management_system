// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { TaskMemberRole } from "@prisma/client";
import type { Client } from "pg";
import { prisma } from "../lib/prisma";
import { activateTask, createTaskDraft } from "../lib/project-management/application/lifecycle-service";
import * as segmentService from "../lib/project-management/application/segment-service";
import { createWorkSegment, updateWorkSegment, softDeleteWorkSegment } from "../lib/project-management/application/segment-service";
import { toProjectManagementServiceError } from "../lib/project-management/application/errors";
import { runProjectManagementAction } from "../lib/project-management/application/action-result";
import { getWorkSegment, listWorkSegmentChanges, listWorkSegments } from "../lib/project-management/queries/resource-queries";
import { assertTaskSegmentMembersIncludedTx } from "../lib/project-management/application/task-member-mutations";
import { cleanupBarrierResources, connectDatabaseClient, databaseBackendPid, startBarrierOperations, throwBarrierErrors, waitForDirectBlockers } from "./helpers/database-barrier";
import type { ProjectManagementActor, ProjectManagementSystemRoleRecord } from "../lib/project-management/identity";

test.describe("统一投入记录", () => {
  test("past and future overlapping records use one model, with CRUD audit and no notifications", async () => {
    const fixture = await createActivatedFixture();
    const notificationBaseline = await prisma.notificationOutbox.count();
    const inAppBaseline = await prisma.inAppNotification.count();
    const created = await createWorkSegment(actor(fixture.member), recordInput(fixture.member.person.id, 9, 11));
    const overlap = await createWorkSegment(actor(fixture.member), recordInput(fixture.member.person.id, 10, 12));
    const futureStart = new Date(Date.now() + 60 * 86_400_000);
    const future = await createWorkSegment(actor(fixture.owner), {
      personId: fixture.member.person.id,
      startAt: futureStart,
      endAt: new Date(futureStart.getTime() + 3_600_000),
      content: "未来时间也只是一条普通记录",
      taskId: fixture.taskId,
    });
    expect(future.segment.taskId).toBe(fixture.taskId);
    for (const key of ["type", "status", "priority", "expectedOutput", "actualOutput", "sourceSplitFromId"]) {
      expect(created.segment).not.toHaveProperty(key);
      expect(await prisma.workSegment.findUniqueOrThrow({ where: { id: created.segment.id } })).not.toHaveProperty(key);
    }
    const updated = await updateWorkSegment(actor(fixture.member), {
      segmentId: created.segment.id, expectedUpdatedAt: created.segment.updatedAt,
      startAt: atHour(8), endAt: atHour(10), content: "调整后的工作内容",
    });
    expect(updated.segment.content).toBe("调整后的工作内容");
    expect(updated.segment.startAt).toBe(atHour(8).toISOString());
    const deleted = await softDeleteWorkSegment(actor(fixture.member), {
      segmentId: updated.segment.id, expectedUpdatedAt: updated.segment.updatedAt,
    });
    expect(deleted.segment.deletedAt).not.toBeNull();
    await softDeleteWorkSegment(actor(fixture.member), {
      segmentId: updated.segment.id, expectedUpdatedAt: updated.segment.updatedAt,
    });
    const listed = await listWorkSegments({ actor: actor(fixture.outsider), input: { personId: fixture.member.person.id } });
    expect(listed.items.map((item) => item.id)).toEqual(expect.arrayContaining([overlap.segment.id, future.segment.id]));
    expect(listed.items.map((item) => item.id)).not.toContain(created.segment.id);
    const changes = await prisma.workSegmentChange.findMany({ where: { segmentId: created.segment.id }, orderBy: { createdAt: "asc" } });
    expect(changes.map((change) => change.action)).toEqual(["CREATE", "UPDATE", "DELETE"]);
    expect(await prisma.domainAuditEvent.count({ where: { entityType: "WorkSegment", entityId: created.segment.id } })).toBe(3);
    expect(await prisma.notificationOutbox.count()).toBe(notificationBaseline);
    expect(await prisma.inAppNotification.count()).toBe(inAppBaseline);
  });

  test("server rejects malformed dates, excessive ranges, blank content and all retired fields", async () => {
    const fixture = await createActivatedFixture();
    const baseline = await prisma.workSegment.count();
    const invalidInputs = [
      { startAt: atHour(10), endAt: atHour(9) },
      { endAt: atHour(9) },
      { startAt: "2026-02-30" },
      { startAt: "2026-08-10T09:00:00" },
      { endAt: new Date(atHour(9).getTime() + 32 * 86_400_000) },
      { content: "  " }, { content: "长".repeat(2001) },
      { type: "PLANNED" }, { type: "ACTUAL" }, { status: "CONFIRMED" },
      { priority: "HIGH" }, { expectedOutput: "输出" }, { actualOutput: "输出" },
      { sources: [] }, { sourceSplitFromId: randomUUID() },
    ];
    for (const input of invalidInputs) {
      await expectServiceError(createWorkSegment(actor(fixture.member), {
        ...recordInput(fixture.member.person.id, 9, 10), ...input,
      }), "VALIDATION_ERROR");
    }
    expect(await prisma.workSegment.count()).toBe(baseline);
    const created = await createWorkSegment(actor(fixture.member), recordInput(fixture.member.person.id, 9, 10));
    await expectServiceError(updateWorkSegment(actor(fixture.member), {
      segmentId: created.segment.id, content: "缺少版本",
    }), "VALIDATION_ERROR");
    await expectServiceError(updateWorkSegment(actor(fixture.member), {
      segmentId: created.segment.id, expectedUpdatedAt: created.segment.updatedAt, endAt: atHour(8),
    }), "VALIDATION_ERROR");
    await expectServiceError(softDeleteWorkSegment(actor(fixture.member), {
      segmentId: created.segment.id, expectedUpdatedAt: created.segment.updatedAt, reason: "已退役入参",
    }), "VALIDATION_ERROR");
    expect(await prisma.workSegmentChange.count({ where: { segmentId: created.segment.id } })).toBe(1);
    for (const retired of ["createActualSegment", "softDeleteActualSegment", "batchCreatePlannedSegments", "movePlannedSegments", "mergePlannedSegments", "confirmPlannedSegment", "partiallyConfirmSegment", "cancelPlannedSegment", "scanSegmentTransitions"]) {
      expect(segmentService).not.toHaveProperty(retired);
    }
  });

  test("global reads, self writes, task owner and administrator management retain authorization", async () => {
    const fixture = await createActivatedFixture();
    const record = await createWorkSegment(actor(fixture.member), {
      ...recordInput(fixture.member.person.id, 9, 10), taskId: fixture.taskId,
    });
    const visible = await getWorkSegment({ actor: actor(fixture.outsider), input: { segmentId: record.segment.id } });
    expect(visible.id).toBe(record.segment.id);
    await expectServiceError(createWorkSegment(actor(fixture.outsider), recordInput(fixture.member.person.id, 10, 11)), "FORBIDDEN");
    await expectServiceError(createWorkSegment(actor(fixture.outsider), {
      ...recordInput(fixture.outsider.person.id, 10, 11), taskId: fixture.taskId,
    }), "ASSOCIATION_INVALID");
    await expectServiceError(updateWorkSegment(actor(fixture.reviewer), {
      segmentId: record.segment.id, expectedUpdatedAt: record.segment.updatedAt, content: "同组成员不可代改",
    }), "FORBIDDEN");
    await expectServiceError(softDeleteWorkSegment(actor(fixture.outsider), {
      segmentId: record.segment.id, expectedUpdatedAt: record.segment.updatedAt,
    }), "FORBIDDEN");
    const managed = await updateWorkSegment(actor(fixture.owner), {
      segmentId: record.segment.id, expectedUpdatedAt: record.segment.updatedAt, content: "负责人管理",
    });
    await softDeleteWorkSegment(actor(fixture.admin), {
      segmentId: managed.segment.id, expectedUpdatedAt: managed.segment.updatedAt,
    });
    await expectServiceError(createWorkSegment(actor(fixture.admin), recordInput(fixture.disabledPerson.id, 10, 11)), "VALIDATION_ERROR");
    const inactiveActor = actor(fixture.member);
    await prisma.person.update({ where: { id: fixture.member.person.id }, data: { status: "INACTIVE" } });
    await expectServiceError(createWorkSegment(inactiveActor, recordInput(fixture.member.person.id, 10, 11)), "FORBIDDEN");
  });

  test("relinking and member removal preserve task association constraints", async () => {
    const fixture = await createActivatedFixture();
    const secondTaskId = await createAdditionalActivatedTask(fixture);
    const record = await createWorkSegment(actor(fixture.member), {
      ...recordInput(fixture.member.person.id, 9, 10), taskId: fixture.taskId,
    });
    await expectServiceError(prisma.$transaction((tx) => assertTaskSegmentMembersIncludedTx(tx, fixture.taskId, [
      { personId: fixture.owner.person.id }, { personId: fixture.reviewer.person.id },
    ])), "VALIDATION_ERROR");
    const relinked = await updateWorkSegment(actor(fixture.member), {
      segmentId: record.segment.id, expectedUpdatedAt: record.segment.updatedAt, taskId: secondTaskId,
    });
    expect(relinked.segment.taskId).toBe(secondTaskId);
    const independent = await updateWorkSegment(actor(fixture.member), {
      segmentId: record.segment.id, expectedUpdatedAt: relinked.segment.updatedAt, taskId: null,
    });
    expect(independent.segment.taskId).toBeNull();
    await prisma.$transaction((tx) => assertTaskSegmentMembersIncludedTx(tx, secondTaskId, [
      { personId: fixture.owner.person.id }, { personId: fixture.reviewer.person.id },
    ]));
    const orphaned = await prisma.workSegment.create({ data: {
      ...recordInput(fixture.outsider.person.id, 15, 16), taskId: fixture.taskId,
      createdByAccountId: fixture.admin.account.id,
    } });
    await expectServiceError(updateWorkSegment(actor(fixture.admin), {
      segmentId: orphaned.id, expectedUpdatedAt: orphaned.updatedAt, content: "不可绕过成员约束",
    }), "ASSOCIATION_INVALID");
  });

  test("stale updates return only a safe authoritative version and persist nothing", async () => {
    const fixture = await createActivatedFixture();
    const created = await createWorkSegment(actor(fixture.member), recordInput(fixture.member.person.id, 9, 10));
    const current = await updateWorkSegment(actor(fixture.member), {
      segmentId: created.segment.id, expectedUpdatedAt: created.segment.updatedAt, content: "权威内容",
    });
    const before = await prisma.workSegment.findUniqueOrThrow({ where: { id: created.segment.id } });
    const result = await runProjectManagementAction({
      event: "test.pm.segment.stale", action: "staleSegmentUpdate", callback: () => updateWorkSegment(actor(fixture.member), {
        segmentId: created.segment.id, expectedUpdatedAt: created.segment.updatedAt, content: "过期内容",
      }),
    });
    expect(result).toEqual({ ok: false, error: {
      code: "STALE_SEGMENT", message: "投入记录已被他人修改，请刷新后重试",
      current: { kind: "SEGMENT", id: created.segment.id, updatedAt: current.segment.updatedAt, versionToken: current.segment.updatedAt },
    } });
    await expectServiceError(softDeleteWorkSegment(actor(fixture.member), {
      segmentId: created.segment.id, expectedUpdatedAt: created.segment.updatedAt,
    }), "STALE_SEGMENT");
    expect(await prisma.workSegment.findUniqueOrThrow({ where: { id: created.segment.id } })).toEqual(before);
    expect(await prisma.workSegmentChange.count({ where: { segmentId: created.segment.id } })).toBe(2);
    const history = await listWorkSegmentChanges({ actor: actor(fixture.member), input: { segmentId: created.segment.id } });
    expect(history.items).toHaveLength(2);
    expect(JSON.stringify(history)).not.toContain(fixture.member.account.id);
  });

  test("simultaneous updates serialize with exactly one winner and one audit", async () => {
    const fixture = await createActivatedFixture();
    const created = await createWorkSegment(actor(fixture.member), recordInput(fixture.member.person.id, 9, 10));
    const outcomes = await runBehindWorkSegmentLockBarrier(created.segment.id, [
      () => updateWorkSegment(actor(fixture.member), { segmentId: created.segment.id, expectedUpdatedAt: created.segment.updatedAt, content: "并发甲" }),
      () => updateWorkSegment(actor(fixture.member), { segmentId: created.segment.id, expectedUpdatedAt: created.segment.updatedAt, content: "并发乙" }),
    ]);
    expect(serviceOutcomeCodes(outcomes)).toEqual(["OK", "STALE_SEGMENT"]);
    expect(await prisma.workSegmentChange.count({ where: { segmentId: created.segment.id } })).toBe(2);
    expect(await prisma.domainAuditEvent.count({ where: { entityType: "WorkSegment", entityId: created.segment.id } })).toBe(2);
  });

  test("simultaneous deletes are idempotent and a deleted record cannot be edited", async () => {
    const fixture = await createActivatedFixture();
    const created = await createWorkSegment(actor(fixture.member), recordInput(fixture.member.person.id, 9, 10));
    const remove = () => softDeleteWorkSegment(actor(fixture.member), { segmentId: created.segment.id, expectedUpdatedAt: created.segment.updatedAt });
    const outcomes = await runBehindWorkSegmentLockBarrier(created.segment.id, [remove, remove]);
    expect(serviceOutcomeCodes(outcomes)).toEqual(["OK", "OK"]);
    const stored = await prisma.workSegment.findUniqueOrThrow({ where: { id: created.segment.id } });
    expect(stored.deletedAt).not.toBeNull();
    expect(await prisma.workSegmentChange.count({ where: { segmentId: created.segment.id, action: "DELETE" } })).toBe(1);
    await expectServiceError(updateWorkSegment(actor(fixture.member), {
      segmentId: created.segment.id, expectedUpdatedAt: stored.updatedAt, content: "删除后不可修改",
    }), "STATE_CONFLICT");
  });
});

function recordInput(personId: string, startHour: number, endHour: number) {
  return { personId, startAt: atHour(startHour), endAt: atHour(endHour), content: `工作内容 ${startHour}-${endHour}` };
}

async function createActivatedFixture(
  options: {
    team?: string;
    techGroup?: string;
    adminIsOwner?: boolean;
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
  await grantRole(admin.account.id, "PROJECT_ADMINISTRATOR");
  await grantRole(resourceManager.account.id, "PROJECT_ADMINISTRATOR");
  const draft = await createTaskDraft(actor(admin), {
    title: `P5 Segment Task ${randomUUID()}`,
    description: "P5 Segment 测试",
    team,
    techGroup,
    priority: "HIGH",
    plannedStartAt: new Date(Date.UTC(2026, 7, 1, 9, 0, 0)).toISOString(),
    members: [
      { personId: owner.person.id, role: "OWNER" },
      ...(options.adminIsOwner
        ? [{ personId: admin.person.id, role: "OWNER" as const }]
        : []),
      { personId: member.person.id, role: "PARTICIPANT" },
      { personId: reviewer.person.id, role: "PARTICIPANT" },
      ...(options.extraMembers ?? []),
    ],
    milestones: [
      milestoneInput("阶段一", "完成阶段一", 1),
      milestoneInput("阶段二", "完成阶段二", 2),
    ],
    termination: terminationInput(5),
    idempotencyKey: `p5-segment-task-${randomUUID()}`,
  });
  await activateTask(actor(owner), {
    taskId: draft.taskId,
    expectedLockVersion: draft.lockVersion,
  });
  return {
    team,
    techGroup,
    admin,
    owner,
    member,
    reviewer,
    outsider,
    resourceManager,
    disabledPerson,
    taskId: draft.taskId,
  };
}

async function createAdditionalActivatedTask(
  fixture: Awaited<ReturnType<typeof createActivatedFixture>>,
) {
  const draft = await createTaskDraft(actor(fixture.admin), {
    title: `P5 Segment Replacement Task ${randomUUID()}`,
    description: "投入任务关联切换测试",
    team: fixture.team,
    techGroup: fixture.techGroup,
    priority: "HIGH",
    plannedStartAt: new Date(Date.UTC(2026, 7, 1, 9, 0, 0)).toISOString(),
    members: [
      { personId: fixture.owner.person.id, role: "OWNER" },
      { personId: fixture.member.person.id, role: "PARTICIPANT" },
      { personId: fixture.reviewer.person.id, role: "PARTICIPANT" },
    ],
    milestones: [milestoneInput("替代阶段", "完成替代阶段", 1)],
    termination: terminationInput(5),
    idempotencyKey: `p5-segment-replacement-task-${randomUUID()}`,
  });
  await activateTask(actor(fixture.owner), {
    taskId: draft.taskId,
    expectedLockVersion: draft.lockVersion,
  });
  return draft.taskId;
}

function milestoneInput(goal: string, criteria: string, daysFromBase: number) {
  return {
    goal,
    completionCriteria: criteria,
    expectedCompletedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    reviewRequirements: "提交文本或链接证据",
    businessDescription: goal,
  };
}

function terminationInput(daysFromBase: number) {
  return {
    name: "Terminal",
    plannedOutcomeCriteria: "所有 Milestone 完成并完成总结",
    plannedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    businessDescription: "结束确认",
  };
}

async function createAccountPerson(displayName: string) {
  const openId = `ou_pm_p5_segment_${randomUUID()}`;
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
  role: "PROJECT_ADMINISTRATOR",
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

function serviceOutcomeCodes(
  outcomes: PromiseSettledResult<unknown>[],
) {
  return outcomes
    .map((outcome) =>
      outcome.status === "fulfilled"
        ? "OK"
        : toProjectManagementServiceError(outcome.reason).code,
    )
    .sort();
}

async function lockWorkSegmentRow(client: Client, segmentId: string) {
  await client.query("BEGIN");
  const pid = await databaseBackendPid(client);
  await client.query(
    'SELECT "id" FROM "WorkSegment" WHERE "id" = $1 FOR UPDATE',
    [segmentId],
  );
  return pid;
}

async function runBehindWorkSegmentLockBarrier<T>(
  segmentId: string,
  operations: [() => Promise<T>, () => Promise<T>],
) {
  let locker: Client | undefined;
  let observer: Client | undefined;
  let transactionMayBeOpen = false;
  let released = false;
  let pending: Promise<T>[] = [];
  let pendingSettlement: Promise<PromiseSettledResult<T>[]> | undefined;
  let pendingBackendPids: number[] = [];
  let pendingHandled = false;
  let result: PromiseSettledResult<T>[] | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    locker = await connectDatabaseClient("segment-barrier-locker");
    observer = await connectDatabaseClient("segment-barrier-observer");
    transactionMayBeOpen = true;
    const lockerPid = await lockWorkSegmentRow(locker, segmentId);
    const started = startBarrierOperations(operations);
    pending = started.pending;
    pendingSettlement = started.settlement;
    const blockedPids = await waitForDirectBlockers(observer, lockerPid, 2);
    pendingBackendPids = blockedPids;
    if (new Set(blockedPids).size < 2) {
      throw new Error("两个 Segment 事务未使用独立 PostgreSQL backend");
    }
    await locker.query("COMMIT");
    released = true;
    result = await Promise.allSettled(pending);
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
  if (!result) throw new Error("Segment barrier 未返回并发结果");
  return result;
}
