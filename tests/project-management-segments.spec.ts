import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { TaskMemberRole } from "@prisma/client";
import type { Client } from "pg";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  createTaskDraft,
} from "../lib/project-management/application/lifecycle-service";
import { updateActiveTask } from "../lib/project-management/application/task-mutation-service";
import {
  batchCreatePlannedSegments,
  batchCancelPlannedSegments,
  batchConfirmPlannedSegments,
  cancelPlannedSegment,
  confirmPlannedSegment,
  createActualSegment,
  createWorkSegment,
  mergePlannedSegments,
  movePlannedSegments,
  partiallyConfirmSegment,
  scanSegmentTransitions,
  softDeleteActualSegment,
  updateWorkSegment,
} from "../lib/project-management/application/segment-service";
import {
  toProjectManagementServiceError,
} from "../lib/project-management/application/errors";
import {
  runProjectManagementAction,
} from "../lib/project-management/application/action-result";
import {
  formatWorkSegmentChange,
  getWorkSegment,
  listWorkSegmentChanges,
  listWorkSegments,
} from "../lib/project-management/queries/resource-queries";
import {
  cleanupBarrierResources,
  connectDatabaseClient,
  startBarrierOperations,
  throwBarrierErrors,
} from "./helpers/database-barrier";
import type {
  ProjectManagementActor,
  ProjectManagementSystemRoleRecord,
} from "../lib/project-management/identity";

test.describe("project management P5 work segment services", () => {
  test("投入历史 formatter 只输出中文安全 DTO 并覆盖所有 action 与组合字段", () => {
    const names = {
      people: new Map([["person-visible", "可见人员"]]),
      tasks: new Map([["task-visible", "可见 Task"]]),
    };
    const baseRow = {
      id: "stable-history-key",
      before: null,
      after: null,
      reason: "",
      actorAccountId: "internal-account-id",
      createdAt: new Date("2026-08-11T04:30:00.000Z"),
      actor: { person: { displayName: "测试操作人" } },
    };
    const actionLabels = new Map([
      ["CREATE", "创建投入"],
      ["UPDATE", "修改投入"],
      ["MERGE", "合并计划（历史）"],
      ["CONFIRM", "确认投入"],
      ["CANCEL", "取消计划"],
      ["DELETE", "删除实际投入"],
    ]);
    for (const [action, label] of actionLabels) {
      const item = formatWorkSegmentChange({ ...baseRow, action }, names);
      expect(item).toMatchObject({
        action: label,
        actorName: "测试操作人",
        reason: "未填写原因",
      });
    }

    const historicalSplit = formatWorkSegmentChange(
      { ...baseRow, action: "SPLIT" },
      names,
    );
    expect(historicalSplit.action).toBe("拆分计划（历史）");
    const partialSplit = formatWorkSegmentChange(
      {
        ...baseRow,
        action: "SPLIT",
        after: {
          sourcePartialConfirmSegmentId: "internal-partial-confirm-id",
        },
      },
      names,
    );
    expect(partialSplit.action).toBe("部分确认后生成剩余计划");
    expect(JSON.stringify(partialSplit)).not.toContain(
      "sourcePartialConfirmSegmentId",
    );
    expect(JSON.stringify(partialSplit)).not.toContain(
      "internal-partial-confirm-id",
    );

    const longContent = "长文本".repeat(80);
    const update = formatWorkSegmentChange(
      {
        ...baseRow,
        action: "UPDATE",
        before: {
          startAt: "2026-08-11T01:00:00.000Z",
          endAt: "2026-08-11T02:00:00.000Z",
          personId: "person-visible",
          content: "旧内容",
          priority: "LOW",
          expectedOutput: "旧预期",
          actualOutput: "旧实际",
          taskId: "task-visible",
          status: "PLANNED",
          unknownInternalField: "不得下发",
        },
        after: {
          startAt: "2026-08-11T03:00:00.000Z",
          endAt: "2026-08-11T04:00:00.000Z",
          personId: "person-hidden",
          content: longContent,
          priority: "HIGH",
          expectedOutput: "新预期",
          actualOutput: "新实际",
          taskId: "task-hidden",
          status: "CONFIRMED",
          unknownInternalField: "仍不得下发",
        },
      },
      names,
    );
    expect(update.differences.map((difference) => difference.label)).toEqual([
      "开始时间",
      "结束时间",
      "人员",
      "内容",
      "优先级",
      "预期输出",
      "实际输出",
      "Task",
      "状态",
    ]);
    expect(update.differences.find(({ label }) => label === "人员")).toMatchObject({
      before: "可见人员",
      after: "不可见对象",
    });
    expect(update.differences.find(({ label }) => label === "Task")).toMatchObject({
      before: "可见 Task",
      after: "不可见对象",
    });
    const truncatedContent = update.differences.find(
      ({ label }) => label === "内容",
    )?.after;
    expect(truncatedContent?.endsWith("…")).toBe(true);
    expect(truncatedContent?.length).toBe(161);
    expect(JSON.stringify(update)).not.toContain("unknownInternalField");
    expect(JSON.stringify(update)).not.toContain("不得下发");

    const unknown = formatWorkSegmentChange(
      {
        ...baseRow,
        action: "FUTURE_INTERNAL_ACTION",
        before: { content: "旧值" },
        after: { content: "新值", lockVersion: 99 },
        actorAccountId: null,
        actor: null,
      },
      names,
    );
    expect(unknown).toMatchObject({
      action: "发生了系统变更",
      actorName: "系统",
      differences: [],
    });
    expect(JSON.stringify(unknown)).not.toContain("FUTURE_INTERNAL_ACTION");
    expect(JSON.stringify(unknown)).not.toContain("lockVersion");

    const accountWithoutPerson = formatWorkSegmentChange(
      {
        ...baseRow,
        action: "CREATE",
        actor: null,
      },
      names,
    );
    expect(accountWithoutPerson.actorName).toBe("管理员或未知操作者");
  });

  test("overlapping Segments are allowed without conflict notifications or outbox", async () => {
    const fixture = await createActivatedFixture();
    const first = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 11),
      content: "允许重叠 A",
      taskId: fixture.taskId,
    });
    const second = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10, 12),
      content: "允许重叠 B",
      taskId: fixture.taskId,
    });

    expect(
      await prisma.workSegment.count({
        where: { id: { in: [first.segment.id, second.segment.id] } },
      }),
    ).toBe(2);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          type: {
            in: ["resource_conflict_opened", "resource_conflict_resolved"],
          },
        },
      }),
    ).toBe(0);
    expect(
      await prisma.inAppNotification.count({
        where: { entityType: "ResourceConflict" },
      }),
    ).toBe(0);
  });

  test("Segment validation, permissions, batch rollback and optimistic lock are enforced", async () => {
    const fixture = await createActivatedFixture();

    await expectServiceError(
      createWorkSegment(actor(fixture.member), {
        personId: fixture.member.person.id,
        type: "PLANNED",
        startAt: atHour(10),
        endAt: atHour(9),
        content: "非法时间",
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
      }),
      "FORBIDDEN",
    );

    const selfSegment = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10),
      taskId: fixture.taskId,
    });
    expect(selfSegment.segment.status).toBe("PLANNED");

    const managerSegment = await createWorkSegment(actor(fixture.resourceManager), {
      ...plannedInput(fixture.member.person.id, 10, 11),
      taskId: fixture.taskId,
    });
    expect(managerSegment.segment.personId).toBe(fixture.member.person.id);

    await expectServiceError(
      createWorkSegment(actor(fixture.outsider), {
        ...plannedInput(fixture.outsider.person.id, 11, 12),
        taskId: fixture.taskId,
      }),
      "ASSOCIATION_INVALID",
    );

    const updated = await updateWorkSegment(actor(fixture.member), {
      segmentId: selfSegment.segment.id,
      expectedUpdatedAt: selfSegment.segment.updatedAt,
      content: "更新后的计划内容",
      reason: "调整投入",
    });
    expect(updated.segment.content).toBe("更新后的计划内容");

    const orphanedSegment = await prisma.workSegment.create({
      data: {
        personId: fixture.outsider.person.id,
        type: "PLANNED",
        status: "PLANNED",
        startAt: atHour(15),
        endAt: atHour(16),
        content: "损坏的非成员关联投入",
        taskId: fixture.taskId,
        createdByAccountId: fixture.resourceManager.account.id,
      },
    });
    await expectServiceError(
      updateWorkSegment(actor(fixture.resourceManager), {
        segmentId: orphanedSegment.id,
        expectedUpdatedAt: orphanedSegment.updatedAt,
        content: "不应写入的内容",
      }),
      "ASSOCIATION_INVALID",
    );
    await expect(
      prisma.workSegment.findUniqueOrThrow({
        where: { id: orphanedSegment.id },
        select: { content: true },
      }),
    ).resolves.toEqual({ content: "损坏的非成员关联投入" });

    await expectServiceError(
      updateWorkSegment(actor(fixture.member), {
        segmentId: selfSegment.segment.id,
        expectedUpdatedAt: selfSegment.segment.updatedAt,
        content: "过期更新",
      }),
      "STALE_SEGMENT",
    );

    const beforeBatchCount = await prisma.workSegment.count();
    await expectServiceError(
      batchCreatePlannedSegments(actor(fixture.resourceManager), {
        segments: [
          {
            ...plannedInput(fixture.member.person.id, 12, 13),
            taskId: fixture.taskId,
          },
          {
            ...plannedInput(fixture.disabledPerson.id, 13, 14),
            taskId: fixture.taskId,
          },
        ],
      }),
      "ASSOCIATION_INVALID",
    );
    expect(await prisma.workSegment.count()).toBe(beforeBatchCount);

    const visibleToMember = await listWorkSegments({
      actor: actor(fixture.member),
      input: { taskId: fixture.taskId },
    });
    expect(visibleToMember.items.map((item) => item.id)).toContain(
      selfSegment.segment.id,
    );
    expect(
      (
        await getWorkSegment({
          actor: actor(fixture.outsider),
          input: { segmentId: selfSegment.segment.id },
        })
      ).id,
    ).toBe(selfSegment.segment.id);
  });

  test("Stale Segment mutations return only the safe authoritative version and write nothing", async () => {
    const fixture = await createActivatedFixture();
    const created = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10),
      taskId: fixture.taskId,
    });
    const authoritativeUpdatedAt = new Date(
      new Date(created.segment.updatedAt).getTime() + 1_000,
    );
    await prisma.workSegment.update({
      where: { id: created.segment.id },
      data: {
        content: "服务端权威内容",
        updatedAt: authoritativeUpdatedAt,
      },
    });

    const authoritativeBeforeStale = await prisma.workSegment.findUniqueOrThrow({
      where: { id: created.segment.id },
    });
    const changesBefore = await prisma.workSegmentChange.count({
      where: { segmentId: created.segment.id },
    });
    const auditsBefore = await prisma.domainAuditEvent.count({
      where: { entityType: "WorkSegment", entityId: created.segment.id },
    });
    const sourceHistoryBefore = await prisma.workSegmentSource.count({
      where: {
        OR: [
          { plannedSegmentId: created.segment.id },
          { actualSegmentId: created.segment.id },
        ],
      },
    });
    const outboxBefore = await prisma.notificationOutbox.count({
      where: { channel: "project-management" },
    });

    const staleResult = await runProjectManagementAction({
      event: "test.pm.segment.real_stale_update",
      action: "testRealStaleSegmentUpdate",
      callback: async () =>
        updateWorkSegment(actor(fixture.member), {
          segmentId: created.segment.id,
          expectedUpdatedAt: created.segment.updatedAt,
          content: "过期请求不得写入",
          reason: "验证真实 Segment stale ActionResult",
        }),
    });
    const authoritativeVersion = authoritativeBeforeStale.updatedAt.toISOString();
    expect(staleResult).toEqual({
      ok: false,
      error: {
        code: "STALE_SEGMENT",
        message: "投入记录已被他人修改，请刷新后重试",
        current: {
          kind: "SEGMENT",
          id: created.segment.id,
          updatedAt: authoritativeVersion,
          versionToken: authoritativeVersion,
        },
      },
    });
    if (staleResult.ok || !staleResult.error.current) {
      throw new Error("真实 stale mutation 未返回安全权威版本");
    }
    expect(Object.keys(staleResult.error.current).sort()).toEqual([
      "id",
      "kind",
      "updatedAt",
      "versionToken",
    ]);
    expect(staleResult.error.current.kind).toBe("SEGMENT");
    if (staleResult.error.current.kind !== "SEGMENT") {
      throw new Error("Segment stale mutation 不得返回 Task current");
    }
    expect(staleResult.error.current.updatedAt).toBe(
      staleResult.error.current.versionToken,
    );

    const deniedResult = await runProjectManagementAction({
      event: "test.pm.segment.denied_stale_update",
      action: "testDeniedStaleSegmentUpdate",
      callback: async () =>
        updateWorkSegment(actor(fixture.outsider), {
          segmentId: created.segment.id,
          expectedUpdatedAt: created.segment.updatedAt,
          content: "无权限用户不得探测版本",
          reason: "验证授权先于 stale",
        }),
    });
    expect(deniedResult).toEqual({
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "你没有执行此操作的权限",
      },
    });

    expect(
      await prisma.workSegment.findUniqueOrThrow({
        where: { id: created.segment.id },
      }),
    ).toEqual(authoritativeBeforeStale);
    expect(
      await prisma.workSegmentChange.count({
        where: { segmentId: created.segment.id },
      }),
    ).toBe(changesBefore);
    expect(
      await prisma.domainAuditEvent.count({
        where: { entityType: "WorkSegment", entityId: created.segment.id },
      }),
    ).toBe(auditsBefore);
    expect(
      await prisma.workSegmentSource.count({
        where: {
          OR: [
            { plannedSegmentId: created.segment.id },
            { actualSegmentId: created.segment.id },
          ],
        },
      }),
    ).toBe(sourceHistoryBefore);
    expect(
      await prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    ).toBe(outboxBefore);
  });

  test("Merge rejects a combined range over 31 days without partial writes", async () => {
    const fixture = await createActivatedFixture();
    const startAt = new Date("2026-09-01T00:00:00.000Z");
    const middleAt = new Date("2026-09-21T00:00:00.000Z");
    const endAt = new Date("2026-10-12T00:00:00.000Z");
    const common = {
      personId: fixture.member.person.id,
      type: "PLANNED" as const,
      content: "跨月连续计划",
      priority: "MEDIUM" as const,
      taskId: fixture.taskId,
    };
    const first = await createWorkSegment(actor(fixture.member), {
      ...common,
      startAt,
      endAt: middleAt,
    });
    const second = await createWorkSegment(actor(fixture.member), {
      ...common,
      startAt: middleAt,
      endAt,
    });
    const ids = [first.segment.id, second.segment.id];
    const changesBefore = await prisma.workSegmentChange.count({
      where: { segmentId: { in: ids } },
    });
    const auditsBefore = await prisma.domainAuditEvent.count({
      where: { entityType: "WorkSegment", entityId: { in: ids } },
    });
    const segmentCountBefore = await prisma.workSegment.count();

    await expectServiceError(
      mergePlannedSegments(actor(fixture.member), {
        segments: [first, second].map((item) => ({
          segmentId: item.segment.id,
          expectedUpdatedAt: item.segment.updatedAt,
        })),
        reason: "尝试合并超过 31 天的计划",
      }),
      "VALIDATION_ERROR",
    );

    const persisted = await prisma.workSegment.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    });
    expect(persisted).toHaveLength(2);
    expect(persisted.every((segment) => segment.status !== "CANCELLED")).toBe(true);
    expect(await prisma.workSegment.count()).toBe(segmentCountBefore);
    expect(
      await prisma.workSegmentChange.count({ where: { segmentId: { in: ids } } }),
    ).toBe(changesBefore);
    expect(
      await prisma.domainAuditEvent.count({
        where: { entityType: "WorkSegment", entityId: { in: ids } },
      }),
    ).toBe(auditsBefore);
  });

  test("Merge accepts an exact 31-day range and records complete provenance", async () => {
    const fixture = await createActivatedFixture();
    const startAt = new Date("2026-09-01T00:00:00.000Z");
    const middleAt = new Date("2026-09-16T00:00:00.000Z");
    const endAt = new Date("2026-10-02T00:00:00.000Z");
    const common = {
      personId: fixture.member.person.id,
      type: "PLANNED" as const,
      content: `恰好 31 天计划 ${randomUUID()}`,
      priority: "MEDIUM" as const,
      taskId: fixture.taskId,
    };
    const first = await createWorkSegment(actor(fixture.member), {
      ...common,
      startAt,
      endAt: middleAt,
    });
    const second = await createWorkSegment(actor(fixture.member), {
      ...common,
      startAt: middleAt,
      endAt,
    });

    const merged = await mergePlannedSegments(actor(fixture.member), {
      segments: [first, second].map((item) => ({
        segmentId: item.segment.id,
        expectedUpdatedAt: item.segment.updatedAt,
      })),
      reason: "验证恰好 31 天边界允许合并",
    });

    expect(merged.segment.startAt).toBe(startAt.toISOString());
    expect(merged.segment.endAt).toBe(endAt.toISOString());
    expect(new Date(merged.segment.endAt).getTime() - new Date(merged.segment.startAt).getTime())
      .toBe(31 * 24 * 60 * 60 * 1_000);
    const originalIds = [first.segment.id, second.segment.id];
    expect(
      await prisma.workSegment.findMany({
        where: { id: { in: originalIds } },
        orderBy: { id: "asc" },
        select: { status: true },
      }),
    ).toEqual([{ status: "CANCELLED" }, { status: "CANCELLED" }]);
    const allIds = [...originalIds, merged.segment.id];
    const changes = await prisma.workSegmentChange.findMany({
      where: { segmentId: { in: allIds }, action: "MERGE" },
      select: { segmentId: true, after: true },
    });
    expect(changes).toHaveLength(3);
    const mergedChange = changes.find(
      (change) => change.segmentId === merged.segment.id,
    );
    expect(mergedChange?.after).toMatchObject({
      mergedFromSegmentIds: expect.arrayContaining(originalIds),
    });
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "WorkSegment",
          entityId: { in: allIds },
          action: "pm.segment.merge",
        },
      }),
    ).toBe(3);
  });

  test("Confirm, partial confirm and Actual sources preserve Planned/Actual relationships", async () => {
    const fixture = await createActivatedFixture();
    const planned = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10),
      taskId: fixture.taskId,
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
    });
    const segmentCountBeforeForgedPartial = await prisma.workSegment.count();
    const sourceCountBeforeForgedPartial = await prisma.workSegmentSource.count();
    await expectServiceError(
      partiallyConfirmSegment(actor(fixture.member), {
        segmentId: partialPlan.segment.id,
        expectedUpdatedAt: partialPlan.segment.updatedAt,
        coveredStartAt: atHour(11.5),
        coveredEndAt: atHour(12.5),
        actual: {
          content: "伪造中段确认",
          expectedOutput: "不应写入",
          actualOutput: "不应写入",
        },
      }),
      "VALIDATION_ERROR",
    );
    expect(await prisma.workSegment.count()).toBe(segmentCountBeforeForgedPartial);
    expect(await prisma.workSegmentSource.count()).toBe(sourceCountBeforeForgedPartial);
    const partial = await partiallyConfirmSegment(actor(fixture.member), {
      segmentId: partialPlan.segment.id,
      expectedUpdatedAt: partialPlan.segment.updatedAt,
      coveredStartAt: atHour(11),
      coveredEndAt: atHour(12.5),
      actual: {
        content: "实际完成计划前段",
        expectedOutput: "完成计划前段",
        actualOutput: "已完成计划前段",
      },
    });
    expect(partial.segment.status).toBe("CANCELLED");
    expect(partial.remainingSegments).toHaveLength(1);
    expect(partial.remainingSegments[0]?.startAt).toBe(atHour(12.5).toISOString());
    expect(partial.remainingSegments[0]?.endAt).toBe(atHour(13).toISOString());

    const planA = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 14, 15),
      taskId: fixture.taskId,
    });
    const planB = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 15, 16),
      taskId: fixture.taskId,
    });
    const actualWithSources = await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(14),
      endAt: atHour(16),
      content: "一次实际投入覆盖两条计划",
      taskId: fixture.taskId,
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

    const onePlanManyActuals = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 20, 22),
      content: "一条计划由多条实际投入覆盖",
      taskId: fixture.taskId,
    });
    const firstActual = await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(20),
      endAt: atHour(21),
      content: "上午实际投入",
      taskId: fixture.taskId,
      sources: [
        {
          plannedSegmentId: onePlanManyActuals.segment.id,
          coveredStartAt: atHour(20),
          coveredEndAt: atHour(21),
        },
      ],
    });
    const secondActual = await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(21),
      endAt: atHour(22),
      content: "下午实际投入",
      taskId: fixture.taskId,
      sources: [
        {
          plannedSegmentId: onePlanManyActuals.segment.id,
          coveredStartAt: atHour(21),
          coveredEndAt: atHour(22),
        },
      ],
    });
    const planWithSources = await getWorkSegment({
      actor: actor(fixture.member),
      input: { segmentId: onePlanManyActuals.segment.id },
    });
    expect(planWithSources.plannedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actualSegmentId: firstActual.segment.id,
          coveredStartAt: atHour(20).toISOString(),
          coveredEndAt: atHour(21).toISOString(),
        }),
        expect.objectContaining({
          actualSegmentId: secondActual.segment.id,
          coveredStartAt: atHour(21).toISOString(),
          coveredEndAt: atHour(22).toISOString(),
        }),
      ]),
    );
    for (const actualSegment of [firstActual.segment, secondActual.segment]) {
      const detail = await getWorkSegment({
        actor: actor(fixture.member),
        input: { segmentId: actualSegment.id },
      });
      expect(detail.actualSources).toEqual([
        expect.objectContaining({ plannedSegmentId: onePlanManyActuals.segment.id }),
      ]);
      const history = await listWorkSegmentChanges({
        actor: actor(fixture.member),
        input: { segmentId: actualSegment.id },
      });
      expect(history.items).toEqual([
        expect.objectContaining({
          action: "创建投入",
          actorName: fixture.member.person.displayName,
          differences: [],
        }),
      ]);
      expect(JSON.stringify(history.items)).not.toContain("actorAccountId");
      expect(JSON.stringify(history.items)).not.toContain('"before"');
      expect(JSON.stringify(history.items)).not.toContain('"after"');
    }
    const foreignHistory = await listWorkSegmentChanges({
      actor: actor(fixture.member),
      input: { segmentId: secondActual.segment.id },
    });
    await expectServiceError(
      listWorkSegmentChanges({
        actor: actor(fixture.member),
        input: {
          segmentId: firstActual.segment.id,
          cursor: foreignHistory.items[0]!.key,
        },
      }),
      "NOT_FOUND",
    );
    await softDeleteActualSegment(actor(fixture.member), {
      segmentId: firstActual.segment.id,
      expectedUpdatedAt: firstActual.segment.updatedAt,
      reason: "验证软删除来源不会继续展示",
    });
    for (const viewer of [fixture.reviewer, fixture.owner, fixture.admin]) {
      const planAfterSourceDeletion = await getWorkSegment({
        actor: actor(viewer),
        input: { segmentId: onePlanManyActuals.segment.id },
      });
      expect(planAfterSourceDeletion.plannedSources).toEqual([
        expect.objectContaining({ actualSegmentId: secondActual.segment.id }),
      ]);
    }

    const unplannedActual = await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(17),
      endAt: atHour(18),
      content: "未提前规划的实际投入",
    });
    expect(unplannedActual.segment.type).toBe("ACTUAL");

    const sourceLeakPlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 18, 19),
      taskId: fixture.taskId,
    });
    await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(18),
      endAt: atHour(19),
      content: "无 Task 的来源 Actual",
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
    expect(ownerView.plannedSources).toHaveLength(1);
    const memberView = await getWorkSegment({
      actor: actor(fixture.member),
      input: { segmentId: sourceLeakPlan.segment.id },
    });
    expect(memberView.plannedSources).toHaveLength(1);
  });

  test("Actual 创建在来源 Task 并发变化后拒绝使用未锁定的新 Task", async () => {
    test.setTimeout(90_000);
    const fixture = await createActivatedFixture();
    const replacementTaskId = await createAdditionalActivatedTask(fixture);
    const planned = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10),
      content: "并发切换 Task 的 Actual 来源",
      taskId: fixture.taskId,
    });
    const actualContent = `不应创建的 Actual ${randomUUID()}`;

    const outcome = await runSourceTaskSwitchBarrier({
      sourceSegmentId: planned.segment.id,
      replacementTaskId,
      createActual: () =>
        createActualSegment(actor(fixture.member), {
          personId: fixture.member.person.id,
          startAt: atHour(9),
          endAt: atHour(10),
          content: actualContent,
          taskId: fixture.taskId,
          sources: [
            {
              plannedSegmentId: planned.segment.id,
              coveredStartAt: atHour(9),
              coveredEndAt: atHour(10),
            },
          ],
        }),
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(toProjectManagementServiceError(outcome.reason)).toMatchObject({
        code: "STATE_CONFLICT",
        message: "投入记录关联在并发操作中已变化，请刷新后重试",
      });
    }
    await expect(
      prisma.workSegment.findUniqueOrThrow({
        where: { id: planned.segment.id },
        select: { taskId: true },
      }),
    ).resolves.toEqual({ taskId: replacementTaskId });
    await expect(
      prisma.workSegment.count({ where: { content: actualContent } }),
    ).resolves.toBe(0);
  });

  test("Cancel and soft-delete do not advance Task or Milestone state", async () => {
    const fixture = await createActivatedFixture();
    const taskBefore = await taskState(fixture.taskId);

    const cancelledPlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10, 11),
      taskId: fixture.taskId,
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
      taskId: fixture.taskId,
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
    });
    const second = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10, 11),
      taskId: fixture.taskId,
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
      "STALE_SEGMENT",
    );
    const firstAfter = await prisma.workSegment.findUniqueOrThrow({
      where: { id: first.segment.id },
      select: { startAt: true, endAt: true },
    });
    expect(firstAfter.startAt.toISOString()).toBe(first.segment.startAt);
  });

  test("成员降级与移动或删除他人 Segment 并发时按 Task 锁后的权限判定", async () => {
    test.setTimeout(90_000);

    for (const operation of ["MOVE", "DELETE"] as const) {
      const fixture = await createActivatedFixture();
      const segment =
        operation === "MOVE"
          ? (
              await createWorkSegment(actor(fixture.owner), {
                ...plannedInput(fixture.member.person.id, 9, 10),
                content: "等待 Owner 降级的移动",
                taskId: fixture.taskId,
              })
            ).segment
          : (
              await createActualSegment(actor(fixture.owner), {
                personId: fixture.member.person.id,
                startAt: atHour(9),
                endAt: atHour(10),
                content: "等待 Owner 降级的删除",
                taskId: fixture.taskId,
              })
            ).segment;
      const task = await prisma.task.findUniqueOrThrow({
        where: { id: fixture.taskId },
        select: {
          lockVersion: true,
          members: {
            where: { removedAt: null },
            select: { id: true, personId: true, role: true },
            orderBy: { id: "asc" },
          },
        },
      });
      const ownerMembership = task.members.find(
        (member) => member.personId === fixture.owner.person.id,
      );
      if (!ownerMembership) throw new Error("并发回归缺少待降级 Owner 成员行");
      const downgradeOwner = () =>
        updateActiveTask(actor(fixture.admin), {
          taskId: fixture.taskId,
          expectedLockVersion: task.lockVersion,
          members: task.members.map((member) => ({
            personId: member.personId,
            role:
              member.personId === fixture.owner.person.id
                ? ("PARTICIPANT" as const)
                : member.role,
          })),
        });
      const mutateOtherPersonsSegment = () =>
        operation === "MOVE"
          ? movePlannedSegments(actor(fixture.owner), {
              moves: [
                {
                  segmentId: segment.id,
                  expectedUpdatedAt: segment.updatedAt,
                  startAt: atHour(11),
                  endAt: atHour(12),
                },
              ],
              reason: "降级后不得移动他人投入",
            })
          : softDeleteActualSegment(actor(fixture.owner), {
              segmentId: segment.id,
              expectedUpdatedAt: segment.updatedAt,
              reason: "降级后不得删除他人投入",
            });

      const outcomes = await runBehindTaskMemberDowngradeBarrier(
        ownerMembership.id,
        downgradeOwner,
        mutateOtherPersonsSegment,
      );
      expect(outcomes[0].status).toBe("fulfilled");
      expect(outcomes[1].status).toBe("rejected");
      if (outcomes[1].status === "rejected") {
        expect(toProjectManagementServiceError(outcomes[1].reason).code).toBe(
          "FORBIDDEN",
        );
      }
      await expect(
        prisma.taskMember.findFirstOrThrow({
          where: {
            taskId: fixture.taskId,
            personId: fixture.owner.person.id,
            removedAt: null,
          },
          select: { role: true },
        }),
      ).resolves.toEqual({ role: "PARTICIPANT" });
      await expect(
        prisma.workSegment.findUniqueOrThrow({
          where: { id: segment.id },
          select: { startAt: true, endAt: true, deletedAt: true },
        }),
      ).resolves.toEqual({
        startAt: new Date(segment.startAt),
        endAt: new Date(segment.endAt),
        deletedAt: null,
      });
    }
  });

  test("A real 100-item move rolls back segments, history, audit and outbox on a late stale item", async () => {
    const fixture = await createActivatedFixture();
    const created = await batchCreatePlannedSegments(actor(fixture.member), {
      segments: Array.from({ length: 100 }, (_, index) => ({
        ...plannedInput(fixture.member.person.id, 9, 10),
        startAt: new Date("2026-09-15T09:00:00.000Z"),
        endAt: new Date("2026-09-15T10:00:00.000Z"),
        content: `百条事务回滚 ${index + 1}`,
        taskId: fixture.taskId,
      })),
    });
    expect(created.segments).toHaveLength(100);
    const sorted = [...created.segments].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const lateStale = sorted[sorted.length - 1];
    if (!lateStale) throw new Error("缺少批量回滚末项");
    await prisma.workSegment.update({
      where: { id: lateStale.id },
      data: { content: `${lateStale.content}（制造 stale）` },
    });
    const ids = sorted.map((segment) => segment.id);
    const beforeRows = await prisma.workSegment.findMany({
      where: { id: { in: ids } },
      select: { id: true, startAt: true, endAt: true, status: true, updatedAt: true },
    });
    const beforeById = new Map(beforeRows.map((segment) => [segment.id, segment]));
    const changesBefore = await prisma.workSegmentChange.count({
      where: { segmentId: { in: ids } },
    });
    const auditsBefore = await prisma.domainAuditEvent.count({
      where: { entityType: "WorkSegment", entityId: { in: ids } },
    });
    const outboxBefore = await prisma.notificationOutbox.count({
      where: { channel: "project-management" },
    });

    await expectServiceError(
      movePlannedSegments(actor(fixture.member), {
        moves: sorted.map((segment) => ({
          segmentId: segment.id,
          expectedUpdatedAt: segment.updatedAt,
          startAt: new Date(new Date(segment.startAt).getTime() + 24 * 60 * 60 * 1_000),
          endAt: new Date(new Date(segment.endAt).getTime() + 24 * 60 * 60 * 1_000),
        })),
        reason: "验证百条全成全败",
      }),
      "STALE_SEGMENT",
    );

    const afterRows = await prisma.workSegment.findMany({
      where: { id: { in: ids } },
      select: { id: true, startAt: true, endAt: true, status: true, updatedAt: true },
    });
    expect(afterRows).toHaveLength(100);
    for (const after of afterRows) {
      const before = beforeById.get(after.id);
      expect(before).toBeTruthy();
      expect(after).toEqual(before);
    }
    expect(
      await prisma.workSegmentChange.count({ where: { segmentId: { in: ids } } }),
    ).toBe(changesBefore);
    expect(
      await prisma.domainAuditEvent.count({
        where: { entityType: "WorkSegment", entityId: { in: ids } },
      }),
    ).toBe(auditsBefore);
    expect(
      await prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    ).toBe(outboxBefore);
  });

  test("Batch cancel validates all 100 items before writing and rolls back a late stale item", async () => {
    const fixture = await createActivatedFixture();
    const created = await batchCreatePlannedSegments(actor(fixture.member), {
      segments: Array.from({ length: 100 }, (_, index) => ({
        ...plannedInput(fixture.member.person.id, 9, 10),
        startAt: new Date("2026-10-15T09:00:00.000Z"),
        endAt: new Date("2026-10-15T10:00:00.000Z"),
        content: `百条批量取消 ${index + 1}`,
        taskId: fixture.taskId,
      })),
    });
    const sorted = [...created.segments].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const lateStale = sorted[sorted.length - 1];
    if (!lateStale) throw new Error("缺少批量取消末项");
    await prisma.workSegment.update({
      where: { id: lateStale.id },
      data: { content: `${lateStale.content}（制造 stale）` },
    });
    const ids = sorted.map((segment) => segment.id);
    const changesBefore = await prisma.workSegmentChange.count({
      where: { segmentId: { in: ids } },
    });
    const auditsBefore = await prisma.domainAuditEvent.count({
      where: { entityType: "WorkSegment", entityId: { in: ids } },
    });

    await expectServiceError(
      batchCancelPlannedSegments(actor(fixture.member), {
        segments: sorted.map((segment) => ({
          segmentId: segment.id,
          expectedUpdatedAt: segment.updatedAt,
        })),
        reason: "验证百条批量取消回滚",
      }),
      "STALE_SEGMENT",
    );

    expect(
      await prisma.workSegment.count({
        where: { id: { in: ids }, status: "CANCELLED" },
      }),
    ).toBe(0);
    expect(
      await prisma.workSegmentChange.count({ where: { segmentId: { in: ids } } }),
    ).toBe(changesBefore);
    expect(
      await prisma.domainAuditEvent.count({
        where: { entityType: "WorkSegment", entityId: { in: ids } },
      }),
    ).toBe(auditsBefore);
  });

  test("Batch cancel rejects an outsider, then cancels every item with history and audit", async () => {
    const fixture = await createActivatedFixture();
    const created = await batchCreatePlannedSegments(actor(fixture.member), {
      segments: [
        {
          ...plannedInput(fixture.member.person.id, 16, 17),
          content: "批量取消成功 A",
          taskId: fixture.taskId,
        },
        {
          ...plannedInput(fixture.member.person.id, 16, 17),
          content: "批量取消成功 B",
          taskId: fixture.taskId,
        },
      ],
    });
    const ids = created.segments.map((segment) => segment.id);
    const input = {
      segments: created.segments.map((segment) => ({
        segmentId: segment.id,
        expectedUpdatedAt: segment.updatedAt,
      })),
      reason: "批量取消成功路径",
    };
    await expectServiceError(
      batchCancelPlannedSegments(actor(fixture.outsider), input),
      "FORBIDDEN",
    );
    expect(
      await prisma.workSegment.count({
        where: { id: { in: ids }, status: "PLANNED" },
      }),
    ).toBe(2);

    const cancelled = await batchCancelPlannedSegments(actor(fixture.member), input);
    expect(cancelled.segments).toHaveLength(2);
    expect(cancelled.segments.every((segment) => segment.status === "CANCELLED")).toBe(true);
    expect(
      await prisma.workSegmentChange.count({
        where: { segmentId: { in: ids }, action: "CANCEL" },
      }),
    ).toBe(2);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "WorkSegment",
          entityId: { in: ids },
          action: "pm.segment.cancel",
        },
      }),
    ).toBe(2);
  });

  test("Batch full confirmation is atomic, permission checked and creates complete Actual sources", async () => {
    const fixture = await createActivatedFixture();
    const created = await batchCreatePlannedSegments(actor(fixture.member), {
      segments: Array.from({ length: 3 }, (_, index) => ({
        ...plannedInput(fixture.member.person.id, 20 + index, 21 + index),
        content: `批量确认 ${index + 1}`,
        taskId: fixture.taskId,
      })),
    });
    const stale = created.segments[1];
    if (!stale) throw new Error("缺少批量确认 stale 项");
    await prisma.workSegment.update({
      where: { id: stale.id },
      data: { content: `${stale.content}（制造 stale）` },
    });
    const ids = created.segments.map((segment) => segment.id);

    await expectServiceError(
      batchConfirmPlannedSegments(actor(fixture.member), {
        segments: created.segments.map((segment) => ({
          segmentId: segment.id,
          expectedUpdatedAt: segment.updatedAt,
        })),
        reason: "验证批量确认回滚",
      }),
      "STALE_SEGMENT",
    );
    expect(
      await prisma.workSegmentSource.count({
        where: { plannedSegmentId: { in: ids } },
      }),
    ).toBe(0);
    expect(
      await prisma.workSegment.count({
        where: { id: { in: ids }, status: "CONFIRMED" },
      }),
    ).toBe(0);

    const authoritative = await prisma.workSegment.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
    });
    await expectServiceError(
      batchConfirmPlannedSegments(actor(fixture.outsider), {
        segments: authoritative.map((segment) => ({
          segmentId: segment.id,
          expectedUpdatedAt: segment.updatedAt,
        })),
      }),
      "FORBIDDEN",
    );
    const confirmed = await batchConfirmPlannedSegments(actor(fixture.member), {
      segments: authoritative.map((segment) => ({
        segmentId: segment.id,
        expectedUpdatedAt: segment.updatedAt,
      })),
      reason: "批量完整确认",
    });
    expect(confirmed.segments).toHaveLength(3);
    expect(confirmed.actualSegments).toHaveLength(3);
    expect(confirmed.segments.every((segment) => segment.status === "CONFIRMED")).toBe(true);
    expect(
      await prisma.workSegmentSource.count({
        where: { plannedSegmentId: { in: ids } },
      }),
    ).toBe(3);
    expect(
      await prisma.workSegmentChange.count({
        where: { segmentId: { in: ids }, action: "CONFIRM" },
      }),
    ).toBe(3);
  });

  test("Reverse overlapping batch inputs acquire Segment locks in one database order", async () => {
    const fixture = await createActivatedFixture();
    const created = await batchCreatePlannedSegments(actor(fixture.member), {
      segments: [
        {
          ...plannedInput(fixture.member.person.id, 9, 10),
          startAt: new Date("2026-10-20T09:00:00.000Z"),
          endAt: new Date("2026-10-20T10:00:00.000Z"),
          content: "逆序锁批量 A",
          taskId: fixture.taskId,
        },
        {
          ...plannedInput(fixture.member.person.id, 10, 11),
          startAt: new Date("2026-10-20T10:00:00.000Z"),
          endAt: new Date("2026-10-20T11:00:00.000Z"),
          content: "逆序锁批量 B",
          taskId: fixture.taskId,
        },
      ],
    });
    const idOrdered = [...created.segments].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const lastById = idOrdered.at(-1);
    if (!lastById) throw new Error("缺少批量锁测试 Segment");
    const segmentIds = idOrdered.map((segment) => segment.id);
    const changesBefore = await prisma.workSegmentChange.count({
      where: { segmentId: { in: segmentIds } },
    });
    const auditsBefore = await prisma.domainAuditEvent.count({
      where: { entityType: "WorkSegment", entityId: { in: segmentIds } },
    });
    const outboxBefore = await prisma.notificationOutbox.count({
      where: { channel: "project-management" },
    });
    const moveInput = (segments: typeof idOrdered, dayOffset: number) => ({
      moves: segments.map((segment) => ({
        segmentId: segment.id,
        expectedUpdatedAt: segment.updatedAt,
        startAt: new Date(
          new Date(segment.startAt).getTime() + dayOffset * 24 * 60 * 60 * 1_000,
        ),
        endAt: new Date(
          new Date(segment.endAt).getTime() + dayOffset * 24 * 60 * 60 * 1_000,
        ),
      })),
      reason: `逆序重叠批量移动 ${dayOffset}`,
    });

    const outcomes = await runBehindOrderedWorkSegmentLockBarrier(lastById.id, [
      () => movePlannedSegments(actor(fixture.member), moveInput(idOrdered, 1)),
      () =>
        movePlannedSegments(
          actor(fixture.member),
          moveInput([...idOrdered].reverse(), 2),
        ),
    ]);
    expect(serviceOutcomeCodes(outcomes)).toEqual(["OK", "STALE_SEGMENT"]);

    const persisted = await prisma.workSegment.findMany({
      where: { id: { in: segmentIds } },
      select: { id: true, startAt: true, endAt: true },
      orderBy: { id: "asc" },
    });
    const appliedOffsets = new Set(
      persisted.map((segment) => {
        const original = idOrdered.find((item) => item.id === segment.id);
        if (!original) throw new Error("缺少原始 Segment");
        return (
          (segment.startAt.getTime() - new Date(original.startAt).getTime()) /
          (24 * 60 * 60 * 1_000)
        );
      }),
    );
    expect([...appliedOffsets]).toHaveLength(1);
    expect([1, 2]).toContain([...appliedOffsets][0]);
    expect(
      await prisma.workSegmentChange.count({
        where: { segmentId: { in: segmentIds } },
      }),
    ).toBe(changesBefore + 2);
    expect(
      await prisma.domainAuditEvent.count({
        where: { entityType: "WorkSegment", entityId: { in: segmentIds } },
      }),
    ).toBe(auditsBefore + 2);
    expect(
      await prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    ).toBe(outboxBefore);
  });

  test("Concurrent full confirmation creates one Actual and one source history", async () => {
    const fixture = await createActivatedFixture();
    const planned = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10),
      content: "并发完整确认",
      taskId: fixture.taskId,
    });
    const input = {
      segmentId: planned.segment.id,
      expectedUpdatedAt: planned.segment.updatedAt,
      actual: { actualOutput: "并发确认实际产出" },
    };
    const outboxBefore = await prisma.notificationOutbox.count({
      where: { channel: "project-management" },
    });
    const outcomes = await runBehindWorkSegmentLockBarrier(
      planned.segment.id,
      [
        () => confirmPlannedSegment(actor(fixture.member), input),
        () => confirmPlannedSegment(actor(fixture.member), input),
      ],
    );
    const results = outcomes.map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value;
    });
    const [left, right] = results;
    if (!left || !right) throw new Error("完整确认并发结果不完整");
    expect([left.createdActual, right.createdActual].sort()).toEqual([
      false,
      true,
    ]);
    expect(left.actualSegment.id).toBe(right.actualSegment.id);
    expect(
      await prisma.workSegmentSource.count({
        where: { plannedSegmentId: planned.segment.id },
      }),
    ).toBe(1);
    const actualIds = await prisma.workSegmentSource.findMany({
      where: { plannedSegmentId: planned.segment.id },
      select: { actualSegmentId: true },
    });
    const affectedIds = [planned.segment.id, ...actualIds.map((row) => row.actualSegmentId)];
    expect(
      await prisma.workSegmentChange.count({
        where: { segmentId: { in: affectedIds }, action: "CONFIRM" },
      }),
    ).toBe(2);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "WorkSegment",
          entityId: { in: affectedIds },
          action: "pm.segment.confirm",
        },
      }),
    ).toBe(2);
    const confirmedSegments = await prisma.workSegment.findMany({
      where: { id: { in: affectedIds } },
      select: { type: true, status: true, deletedAt: true },
    });
    expect(
      confirmedSegments.sort((left, right) =>
        left.type.localeCompare(right.type),
      ),
    ).toEqual([
      { type: "ACTUAL", status: "CONFIRMED", deletedAt: null },
      { type: "PLANNED", status: "CONFIRMED", deletedAt: null },
    ]);
    expect(
      await prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    ).toBe(outboxBefore);
  });

  test("Concurrent partial confirm, cancel and soft delete each have one state winner", async () => {
    const fixture = await createActivatedFixture();
    const partialPlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 11, 13),
      content: "并发部分确认",
      taskId: fixture.taskId,
    });
    const partialInput = {
      segmentId: partialPlan.segment.id,
      expectedUpdatedAt: partialPlan.segment.updatedAt,
      coveredStartAt: atHour(11),
      coveredEndAt: atHour(12.5),
      reason: "并发部分确认",
      actual: {
        content: "并发部分确认 Actual",
        expectedOutput: "完成前段",
        actualOutput: "已完成前段",
      },
    };
    const partialOutboxBefore = await prisma.notificationOutbox.count({
      where: { channel: "project-management" },
    });
    const partialOutcomes = await runBehindWorkSegmentLockBarrier(
      partialPlan.segment.id,
      [
        () => partiallyConfirmSegment(actor(fixture.member), partialInput),
        () => partiallyConfirmSegment(actor(fixture.member), partialInput),
      ],
    );
    expect(serviceOutcomeCodes(partialOutcomes)).toEqual(["OK", "STALE_SEGMENT"]);
    const partialSources = await prisma.workSegmentSource.findMany({
      where: { plannedSegmentId: partialPlan.segment.id },
      select: { actualSegmentId: true },
    });
    expect(partialSources).toHaveLength(1);
    const partialActualId = partialSources[0]?.actualSegmentId;
    if (!partialActualId) throw new Error("部分确认缺少 Actual 来源");
    const remainingPlans = await prisma.workSegment.findMany({
      where: { sourceSplitFromId: partialPlan.segment.id, deletedAt: null },
      orderBy: { startAt: "asc" },
      select: { id: true, type: true, status: true },
    });
    expect(remainingPlans).toHaveLength(1);
    expect(
      remainingPlans.every((segment) => segment.type === "PLANNED"),
    ).toBe(true);
    expect(
      await prisma.workSegmentChange.count({
        where: {
          segmentId: {
            in: [
              partialPlan.segment.id,
              partialActualId,
              ...remainingPlans.map((segment) => segment.id),
            ],
          },
          action: { in: ["CONFIRM", "SPLIT"] },
        },
      }),
    ).toBe(3);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "WorkSegment",
          entityId: {
            in: [
              partialPlan.segment.id,
              partialActualId,
              ...remainingPlans.map((segment) => segment.id),
            ],
          },
          action: { in: ["pm.segment.confirm", "pm.segment.split"] },
        },
      }),
    ).toBe(3);
    expect(
      await prisma.workSegment.findUniqueOrThrow({
        where: { id: partialPlan.segment.id },
        select: { status: true },
      }),
    ).toEqual({ status: "CANCELLED" });
    expect(
      await prisma.workSegment.findUniqueOrThrow({
        where: { id: partialActualId },
        select: { type: true, status: true, deletedAt: true },
      }),
    ).toEqual({ type: "ACTUAL", status: "CONFIRMED", deletedAt: null });
    expect(
      await prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    ).toBe(partialOutboxBefore);

    const cancelPlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 14, 15),
      content: "并发取消",
      taskId: fixture.taskId,
    });
    const cancelInput = {
      segmentId: cancelPlan.segment.id,
      expectedUpdatedAt: cancelPlan.segment.updatedAt,
      reason: "并发取消",
    };
    const cancelOutboxBefore = await prisma.notificationOutbox.count({
      where: { channel: "project-management" },
    });
    const cancelOutcomes = await runBehindWorkSegmentLockBarrier(
      cancelPlan.segment.id,
      [
        () => cancelPlannedSegment(actor(fixture.member), cancelInput),
        () => cancelPlannedSegment(actor(fixture.member), cancelInput),
      ],
    );
    expect(serviceOutcomeCodes(cancelOutcomes)).toEqual(["OK", "STALE_SEGMENT"]);
    expect(
      await prisma.workSegmentChange.count({
        where: { segmentId: cancelPlan.segment.id, action: "CANCEL" },
      }),
    ).toBe(1);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "WorkSegment",
          entityId: cancelPlan.segment.id,
          action: "pm.segment.cancel",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.workSegment.findUniqueOrThrow({
        where: { id: cancelPlan.segment.id },
        select: { status: true },
      }),
    ).toEqual({ status: "CANCELLED" });
    expect(
      await prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    ).toBe(cancelOutboxBefore);

    const actual = await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(16),
      endAt: atHour(17),
      content: "并发逻辑删除",
      taskId: fixture.taskId,
    });
    const deleteInput = {
      segmentId: actual.segment.id,
      expectedUpdatedAt: actual.segment.updatedAt,
      reason: "并发逻辑删除",
    };
    const deleteOutboxBefore = await prisma.notificationOutbox.count({
      where: { channel: "project-management" },
    });
    const deleteOutcomes = await runBehindWorkSegmentLockBarrier(
      actual.segment.id,
      [
        () => softDeleteActualSegment(actor(fixture.member), deleteInput),
        () => softDeleteActualSegment(actor(fixture.member), deleteInput),
      ],
    );
    expect(serviceOutcomeCodes(deleteOutcomes)).toEqual(["OK", "STALE_SEGMENT"]);
    expect(
      await prisma.workSegmentChange.count({
        where: { segmentId: actual.segment.id, action: "DELETE" },
      }),
    ).toBe(1);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "WorkSegment",
          entityId: actual.segment.id,
          action: "pm.segment.delete",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.workSegment.findUniqueOrThrow({
        where: { id: actual.segment.id },
        select: { status: true, deletedAt: true },
      }),
    ).toEqual({ status: "CANCELLED", deletedAt: expect.any(Date) });
    expect(
      await prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    ).toBe(deleteOutboxBefore);
  });

  test("Segment transition scan writes change history and audit", async () => {
    const fixture = await createActivatedFixture();
    const transitionNow = new Date("2025-06-01T10:00:00.000Z");
    const inProgressPlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 11),
      startAt: new Date("2025-06-01T09:00:00.000Z"),
      endAt: new Date("2025-06-01T11:00:00.000Z"),
      taskId: fixture.taskId,
    });
    const duePlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 7, 8),
      startAt: new Date("2025-06-01T07:00:00.000Z"),
      endAt: new Date("2025-06-01T08:00:00.000Z"),
      taskId: fixture.taskId,
    });

    const [pendingConfirmationCount, inProgressCount] = await Promise.all([
      prisma.workSegment.count({
        where: {
          type: "PLANNED",
          status: { in: ["PLANNED", "IN_PROGRESS"] },
          endAt: { lte: transitionNow },
          deletedAt: null,
        },
      }),
      prisma.workSegment.count({
        where: {
          type: "PLANNED",
          status: "PLANNED",
          startAt: { lte: transitionNow },
          endAt: { gt: transitionNow },
          deletedAt: null,
        },
      }),
    ]);
    const result = await scanSegmentTransitions(transitionNow);
    expect(result).toEqual({
      pendingConfirmationCount: Math.min(pendingConfirmationCount, 500),
      inProgressCount: Math.min(inProgressCount, 500),
    });

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
    const dueNotification = await prisma.notificationOutbox.findUnique({
      where: {
        eventKey: `pm:segment:confirmation_due:${duePlan.segment.id}:${duePlan.segment.endAt}:feishu`,
      },
      select: { payload: true },
    });
    expect(JSON.parse(dueNotification?.payload ?? "null")).toEqual(
      expect.objectContaining({
        linkPath: `/progress?focus=${duePlan.segment.id}`,
      }),
    );
  });

  test("Concurrent transition scans have one winner and no duplicate side effects", async () => {
    const fixture = await createActivatedFixture();
    const duePlan = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 7, 8),
      startAt: new Date("2025-01-01T07:00:00.000Z"),
      endAt: new Date("2025-01-01T08:00:00.000Z"),
      content: `并发到期转换 ${randomUUID()}`,
      taskId: fixture.taskId,
    });
    const eventKey = `pm:segment:confirmation_due:${duePlan.segment.id}:${duePlan.segment.endAt}`;
    const outcomes = await runBehindWorkSegmentLockBarrier(duePlan.segment.id, [
      () => scanSegmentTransitions(new Date("2025-01-02T10:00:00.000Z")),
      () => scanSegmentTransitions(new Date("2025-01-02T10:00:00.000Z")),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    const [left, right] = outcomes.map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value;
    });
    if (!left || !right) throw new Error("缺少并发 transition 扫描结果");
    expect(left.pendingConfirmationCount + right.pendingConfirmationCount).toBe(1);
    expect(
      await prisma.workSegment.findUniqueOrThrow({
        where: { id: duePlan.segment.id },
        select: { status: true },
      }),
    ).toEqual({ status: "PENDING_CONFIRMATION" });
    expect(
      await prisma.workSegmentChange.count({
        where: {
          segmentId: duePlan.segment.id,
          reason: "Planned Segment 已到期，等待确认",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "WorkSegment",
          entityId: duePlan.segment.id,
          action: "pm.segment.update",
          source: "CRON",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: { eventKey: `${eventKey}:feishu` },
      }),
    ).toBe(1);
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
    description: "Actual 来源并发 Task 切换测试",
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

function plannedInput(personId: string, startHour: number, endHour: number) {
  return {
    personId,
    type: "PLANNED",
    startAt: atHour(startHour),
    endAt: atHour(endHour),
    content: `计划投入 ${startHour}-${endHour}`,
    priority: "MEDIUM",
  };
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

async function databaseBackendPid(client: Client) {
  const result = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = result.rows[0]?.pid;
  if (!pid) throw new Error("无法取得 PostgreSQL backend pid");
  return pid;
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

async function lockTaskMemberRow(client: Client, taskMemberId: string) {
  await client.query("BEGIN");
  const pid = await databaseBackendPid(client);
  await client.query(
    'SELECT "id" FROM "TaskMember" WHERE "id" = $1 FOR UPDATE',
    [taskMemberId],
  );
  return pid;
}

async function waitForDirectBlockers(
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
  throw new Error(
    `未在期限内观察到 ${expectedCount} 个事务被 backend ${blockerPid} 阻塞`,
  );
}

async function runBehindTaskMemberDowngradeBarrier(
  taskMemberId: string,
  downgradeOwner: () => Promise<unknown>,
  mutateSegment: () => Promise<unknown>,
): Promise<
  [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]
> {
  let locker: Client | undefined;
  let observer: Client | undefined;
  let transactionMayBeOpen = false;
  let released = false;
  let pending: Promise<unknown>[] = [];
  let pendingSettlement:
    | Promise<PromiseSettledResult<unknown>[]>
    | undefined;
  let pendingBackendPids: number[] = [];
  let pendingHandled = false;
  let result:
    | [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]
    | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    locker = await connectDatabaseClient("task-member-downgrade-locker");
    observer = await connectDatabaseClient("task-member-downgrade-observer");
    transactionMayBeOpen = true;
    const lockerPid = await lockTaskMemberRow(locker, taskMemberId);
    const downgradePromise = Promise.resolve().then(downgradeOwner);
    void downgradePromise.catch(() => undefined);
    pending = [downgradePromise];
    pendingSettlement = Promise.allSettled(pending);
    await waitForDirectBlockers(observer, lockerPid, 1);

    const mutationPromise = Promise.resolve().then(mutateSegment);
    void mutationPromise.catch(() => undefined);
    pending = [downgradePromise, mutationPromise];
    pendingSettlement = Promise.allSettled(pending);
    const { directBlockerPid, indirectBlockerPid } =
      await waitForSingleDirectAndIndirectBlocker(observer, lockerPid);
    pendingBackendPids = [directBlockerPid, indirectBlockerPid];
    await locker.query("COMMIT");
    released = true;
    const settled = await Promise.allSettled(pending);
    pendingHandled = true;
    if (settled.length !== 2) throw new Error("成员降级屏障结果数量错误");
    result = [settled[0]!, settled[1]!];
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
  if (!result) throw new Error("成员降级屏障未返回并发结果");
  return result;
}

async function runSourceTaskSwitchBarrier(input: {
  sourceSegmentId: string;
  replacementTaskId: string;
  createActual: () => Promise<unknown>;
}): Promise<PromiseSettledResult<unknown>> {
  let locker: Client | undefined;
  let observer: Client | undefined;
  let transactionMayBeOpen = false;
  let released = false;
  let pendingSettlement:
    | Promise<PromiseSettledResult<unknown>[]>
    | undefined;
  let pendingBackendPids: number[] = [];
  let pendingHandled = false;
  let result: PromiseSettledResult<unknown> | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    locker = await connectDatabaseClient("source-task-switch-locker");
    observer = await connectDatabaseClient("source-task-switch-observer");
    transactionMayBeOpen = true;
    const lockerPid = await lockWorkSegmentRow(locker, input.sourceSegmentId);
    const pending = Promise.resolve().then(input.createActual);
    void pending.catch(() => undefined);
    pendingSettlement = Promise.allSettled([pending]);
    pendingBackendPids = await waitForDirectBlockers(observer, lockerPid, 1);

    await locker.query(
      'UPDATE "WorkSegment" SET "taskId" = $1 WHERE "id" = $2',
      [input.replacementTaskId, input.sourceSegmentId],
    );
    await locker.query("COMMIT");
    released = true;
    [result] = await pendingSettlement;
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
  if (!result) throw new Error("Actual 来源 Task 切换屏障未返回结果");
  return result;
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

async function runBehindOrderedWorkSegmentLockBarrier<T>(
  lastSegmentId: string,
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
    locker = await connectDatabaseClient("ordered-segment-locker");
    observer = await connectDatabaseClient("ordered-segment-observer");
    transactionMayBeOpen = true;
    const lockerPid = await lockWorkSegmentRow(locker, lastSegmentId);
    const started = startBarrierOperations(operations);
    pending = started.pending;
    pendingSettlement = started.settlement;
    const { directBlockerPid, indirectBlockerPid } =
      await waitForSingleDirectAndIndirectBlocker(observer, lockerPid);
    pendingBackendPids = [directBlockerPid, indirectBlockerPid];
    if (directBlockerPid === indirectBlockerPid) {
      throw new Error("逆序批量事务未使用独立 PostgreSQL backend");
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
  if (!result) throw new Error("Ordered Segment barrier 未返回并发结果");
  return result;
}

async function waitForSingleDirectAndIndirectBlocker(
  observer: Client,
  lockerPid: number,
) {
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    const direct = await directBlockerPids(observer, lockerPid);
    const directBlockerPid = direct[0];
    if (direct.length === 1 && directBlockerPid) {
      const indirect = await directBlockerPids(observer, directBlockerPid);
      const indirectBlockerPid = indirect.find((pid) => pid !== lockerPid);
      if (indirectBlockerPid) {
        return { directBlockerPid, indirectBlockerPid };
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    "未观察到 external(max id) → first(min id) → second(min id) 的固定锁顺序",
  );
}

async function directBlockerPids(observer: Client, blockerPid: number) {
  const result = await observer.query<{ pid: number }>(
    `SELECT "activity"."pid"
     FROM "pg_stat_activity" AS "activity"
     WHERE $1::int = ANY(pg_blocking_pids("activity"."pid"))
     ORDER BY "activity"."pid" ASC`,
    [blockerPid],
  );
  return [...new Set(result.rows.map((row) => row.pid))];
}

async function expectSegmentChange(segmentId: string, reason: string) {
  await prisma.workSegmentChange.findFirstOrThrow({
    where: { segmentId, action: "UPDATE", reason },
  });
}
