import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  createTaskDraft,
} from "../lib/project-management/application/lifecycle-service";
import {
  cancelPlannedSegment,
  createActualSegment,
  createWorkSegment,
  movePlannedSegments,
  updateWorkSegment,
} from "../lib/project-management/application/segment-service";
import {
  acknowledgeConflict,
  applyConflictSuggestion,
  ignoreConflict,
  previewConflictSuggestion,
  resolveConflict,
  scanConflictsForPerson,
  scanResourceConflicts,
  scanResourceConflictsForDefaultWindow,
} from "../lib/project-management/application/conflict-service";
import {
  getResourceConflict,
  listResourceConflicts,
} from "../lib/project-management/queries/resource-queries";
import {
  toProjectManagementServiceError,
} from "../lib/project-management/application/errors";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import {
  cleanupBarrierResources,
  connectDatabaseClient,
  signalPendingBackends,
  startBarrierOperations,
  throwBarrierErrors,
} from "./helpers/database-barrier";

async function captureStructuredLogs<T>(callback: () => Promise<T>) {
  const lines: string[] = [];
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const originalLogFormat = process.env.LOG_FORMAT;
  const originalLogLevel = process.env.LOG_LEVEL;
  const capture = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  process.env.LOG_FORMAT = "json";
  process.env.LOG_LEVEL = "debug";
  try {
    const result = await callback();
    return {
      result,
      entries: lines.flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return parsed && typeof parsed === "object"
            ? [parsed as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      }),
    };
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    restoreEnvironmentValue("LOG_FORMAT", originalLogFormat);
    restoreEnvironmentValue("LOG_LEVEL", originalLogLevel);
  }
}

function restoreEnvironmentValue(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

test.describe("project management P5 resource conflict services", () => {
  test("Database barrier helpers contain connection, synchronous operation and rollback failures", async () => {
    const connectFailure = new Error("synthetic connect failure");
    const connectCleanupFailure = new Error("synthetic connect cleanup failure");
    const connectEvents: string[] = [];
    const failedClient = {
      connect: async () => {
        connectEvents.push("connect");
        throw connectFailure;
      },
      end: async () => {
        connectEvents.push("end");
        throw connectCleanupFailure;
      },
      connection: {
        stream: {
          destroy: () => {
            connectEvents.push("destroy");
          },
        },
      },
    } as unknown as Client;
    let connectError: unknown;
    try {
      await connectDatabaseClient("failing-connect", () => failedClient);
    } catch (error) {
      connectError = error;
    }
    expect(connectEvents).toEqual(["connect", "end", "destroy"]);
    expect(connectError).toBeInstanceOf(AggregateError);
    expect((connectError as AggregateError).errors[0]).toBe(connectFailure);

    const synchronousFailure = new Error("synthetic synchronous operation failure");
    const synchronousStarted = startBarrierOperations<unknown>([
      () => {
        throw synchronousFailure;
      },
      async () => "managed success",
    ]);
    const synchronousOutcomes = await synchronousStarted.settlement;
    expect(synchronousOutcomes).toEqual([
      { status: "rejected", reason: synchronousFailure },
      { status: "fulfilled", value: "managed success" },
    ]);

    const cleanupEvents: string[] = [];
    let releasePending: (() => void) | undefined;
    const pendingStarted = startBarrierOperations<unknown>([
      () =>
        new Promise<void>((resolve) => {
          releasePending = () => {
            cleanupEvents.push("pending-released");
            resolve();
          };
        }),
    ]);
    await Promise.resolve();
    const rollbackFailure = new Error("synthetic rollback failure");
    const locker = {
      query: async () => {
        cleanupEvents.push("rollback");
        throw rollbackFailure;
      },
      end: async () => {
        cleanupEvents.push("locker-end");
      },
      connection: {
        stream: {
          destroy: () => {
            cleanupEvents.push("locker-destroy");
            releasePending?.();
          },
        },
      },
    } as unknown as Client;
    const observer = {
      end: async () => {
        cleanupEvents.push("observer-end");
      },
      connection: { stream: { destroy: () => undefined } },
    } as unknown as Client;
    const primaryError = new Error("synthetic primary failure");
    const cleanupErrors = await cleanupBarrierResources({
      locker,
      observer,
      rollbackRequired: true,
      pendingSettlement: pendingStarted.settlement,
      pendingHandled: false,
      primaryError,
    });
    expect(cleanupEvents).toEqual([
      "rollback",
      "locker-destroy",
      "pending-released",
      "locker-end",
      "observer-end",
    ]);
    expect(cleanupErrors).toHaveLength(1);
    let aggregate: unknown;
    try {
      throwBarrierErrors(true, primaryError, cleanupErrors);
    } catch (error) {
      aggregate = error;
    }
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors[0]).toBe(primaryError);
  });

  test("Database barrier cleanup cancels timed-out Prisma transactions before returning", async () => {
    const person = await createAccountPerson("P5 Barrier Timeout Person");
    let locker: Client | undefined;
    let observer: Client | undefined;
    let pendingSettlement:
      | Promise<PromiseSettledResult<unknown>[]>
      | undefined;
    let pendingBackendPids: number[] = [];
    let settlementObserved = false;
    let cleanupErrors: Error[] | undefined;
    let resourcesHandled = false;
    let primaryError: unknown;
    let hasPrimaryError = false;
    try {
      locker = await connectDatabaseClient("timeout-cleanup-locker");
      observer = await connectDatabaseClient("timeout-cleanup-observer");
      const lockerPid = await lockConflictPerson(locker, person.person.id);
      const started = startBarrierOperations([
        () =>
          scanConflictsForPerson({
            personId: person.person.id,
            startAt: atHour(9),
            endAt: atHour(10),
          }),
      ]);
      pendingSettlement = started.settlement.then((outcomes) => {
        settlementObserved = true;
        return outcomes;
      });
      const [blockedPid] = await waitForDirectBlockers(
        observer,
        lockerPid,
        1,
      );
      if (!blockedPid) throw new Error("未观察到超时清理测试的 Prisma backend");
      pendingBackendPids = [blockedPid];
      cleanupErrors = await cleanupBarrierResources({
        locker,
        observer,
        rollbackRequired: false,
        pendingSettlement,
        pendingBackendPids,
        pendingOperationTimeoutMs: 25,
        pendingHandled: false,
        primaryError: undefined,
      });
      resourcesHandled = true;
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
    }
    if (!resourcesHandled) {
      const emergencyCleanupErrors = await cleanupBarrierResources({
        locker,
        observer,
        rollbackRequired: Boolean(locker),
        pendingSettlement,
        pendingBackendPids,
        pendingOperationTimeoutMs: 25,
        pendingHandled: settlementObserved,
        primaryError,
      });
      throwBarrierErrors(
        hasPrimaryError,
        primaryError,
        emergencyCleanupErrors,
      );
    }
    throwBarrierErrors(hasPrimaryError, primaryError, []);
    expect(settlementObserved).toBe(true);
    expect(cleanupErrors?.map((error) => error.message)).toEqual([
      "等待 pending operation 失败",
      "pending operation 执行失败",
    ]);
    if (!pendingSettlement) throw new Error("缺少超时清理 settlement");
    const outcomes = await pendingSettlement;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("rejected");
  });

  test("Database barrier terminate fallback targets the same safe backend and settles before returning", async () => {
    let target: Client | undefined;
    let observer: Client | undefined;
    let pendingSettlement:
      | Promise<PromiseSettledResult<unknown>[]>
      | undefined;
    let targetPid: number | undefined;
    let cleanupCompleted = false;
    let settlementObserved = false;
    let settlementBeforeTerminate = false;
    let terminateDispatched = false;
    const targetConnectionErrors: Error[] = [];
    const signalEvents: Array<{
      signal: "cancel" | "terminate";
      targetPids: readonly number[];
      settled: boolean;
    }> = [];
    try {
      target = await connectDatabaseClient("terminate-target");
      target.on("error", (error) => {
        targetConnectionErrors.push(error);
      });
      observer = await connectDatabaseClient("terminate-observer");
      const identity = await observer.query<{
        databaseName: string;
        notificationDeliveryDisabled: boolean;
      }>(
        `SELECT current_database() AS "databaseName",
                $1::boolean AS "notificationDeliveryDisabled"`,
        [process.env.NOTIFICATION_DELIVERY_DISABLED === "true"],
      );
      expect(identity.rows[0]).toEqual({
        databaseName: expect.stringMatching(/_test$/),
        notificationDeliveryDisabled: true,
      });
      targetPid = await databaseBackendPid(target);
      const started = startBarrierOperations([
        () => target!.query("SELECT pg_sleep($1)", [60]),
      ]);
      pendingSettlement = started.settlement.then((outcomes) => {
        settlementObserved = true;
        settlementBeforeTerminate = !terminateDispatched;
        return outcomes;
      });
      const primaryError = new Error(
        "synthetic terminate fallback primary failure",
      );
      const cleanupErrors = await cleanupBarrierResources({
        locker: target,
        observer,
        rollbackRequired: false,
        pendingSettlement,
        pendingBackendPids: [targetPid],
        pendingOperationTimeoutMs: 25,
        cancelledOperationSettlementTimeoutMs: 25,
        backendSignalRunner: async ({ signal, targetPids, send }) => {
          signalEvents.push({
            signal,
            targetPids: [...targetPids],
            settled: settlementObserved,
          });
          if (signal === "cancel") return;
          terminateDispatched = true;
          await send();
        },
        pendingHandled: false,
        primaryError,
      });
      cleanupCompleted = true;
      expect(signalEvents).toEqual([
        { signal: "cancel", targetPids: [targetPid], settled: false },
        { signal: "terminate", targetPids: [targetPid], settled: false },
      ]);
      expect(settlementObserved).toBe(true);
      expect(settlementBeforeTerminate).toBe(false);
      expect(
        targetConnectionErrors.every(
          (error) => error.message === "Connection terminated unexpectedly",
        ),
      ).toBe(true);
      expect(cleanupErrors.map((error) => error.message)).toEqual([
        "等待 pending operation 失败",
        "取消 backend 后等待 pending operation 失败",
        "pending operation 执行失败",
      ]);
      const outcomes = await pendingSettlement;
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.status).toBe("rejected");
      let aggregate: unknown;
      try {
        throwBarrierErrors(true, primaryError, cleanupErrors);
      } catch (error) {
        aggregate = error;
      }
      expect(aggregate).toBeInstanceOf(AggregateError);
      expect((aggregate as AggregateError).errors[0]).toBe(primaryError);
    } finally {
      if (!cleanupCompleted) {
        await cleanupBarrierResources({
          locker: target,
          observer,
          rollbackRequired: false,
          pendingSettlement,
          pendingBackendPids: targetPid ? [targetPid] : [],
          pendingOperationTimeoutMs: 25,
          cancelledOperationSettlementTimeoutMs: 25,
          pendingHandled: settlementObserved,
          primaryError: undefined,
        });
      }
    }
  });

  test("Database barrier backend signals reject unsafe database, backend type and observer PIDs", async () => {
    let signalRunnerCalls = 0;
    const runner = async () => {
      signalRunnerCalls += 1;
    };
    await expect(
      signalPendingBackends(
        fakeSignalObserver({ databaseName: "management_system" }),
        [7101],
        "terminate",
        runner,
      ),
    ).rejects.toThrow("拒绝在非 _test 数据库取消 backend");
    await expect(
      signalPendingBackends(
        fakeSignalObserver({
          activities: [
            {
              pid: 7102,
              databaseName: "another_management_system_test",
              backendType: "client backend",
            },
          ],
        }),
        [7102],
        "terminate",
        runner,
      ),
    ).rejects.toThrow("拒绝取消非当前测试数据库 client backend 7102");
    await expect(
      signalPendingBackends(
        fakeSignalObserver({
          activities: [
            {
              pid: 7103,
              databaseName: "management_system_test",
              backendType: "autovacuum worker",
            },
          ],
        }),
        [7103],
        "terminate",
        runner,
      ),
    ).rejects.toThrow("拒绝取消非当前测试数据库 client backend 7103");
    await expect(
      signalPendingBackends(
        fakeSignalObserver({ observerPid: 7104 }),
        [7104],
        "terminate",
        runner,
      ),
    ).rejects.toThrow("拒绝取消 barrier observer 自身 backend");
    expect(signalRunnerCalls).toBe(0);
  });

  test("Allocation scanner uses half-open intervals and opens conflicts only above 100%", async () => {
    const fixture = await createActivatedFixture();
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 50),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10, 11, 50),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const noConflict = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    expect(noConflict.createdCount).toBe(0);

    const overlapA = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 12, 13, 50.01),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const overlapB = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 12.5, 13.5, 50),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const scan = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(12),
      endAt: atHour(14),
    });
    expect(scan.createdCount).toBe(0);
    expect(scan.unchangedCount).toBe(1);
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
        segments: {
          every: {
            segmentId: { in: [overlapA.segment.id, overlapB.segment.id] },
          },
        },
      },
      include: { segments: true },
    });
    expect(conflict.startAt.toISOString()).toBe(atHour(12.5).toISOString());
    expect(conflict.endAt.toISOString()).toBe(atHour(13).toISOString());
    await expectProjectManagementOutbox(
      `pm:conflict:opened:${conflict.fingerprint}:feishu`,
      "resource_conflict_opened",
    );
  });

  test("Segment create, update and cancel automatically rescan without a manual scanner call", async () => {
    const fixture = await createActivatedFixture({
      title: "P5 Automatic Mutation Rescan",
    });
    const first = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const second = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
        status: "OPEN",
      },
    });
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: conflict.id,
          action: "pm.conflict.scan",
        },
      }),
    ).toBe(1);

    const moved = await updateWorkSegment(actor(fixture.member), {
      segmentId: second.segment.id,
      expectedUpdatedAt: second.segment.updatedAt,
      startAt: atHour(11),
      endAt: atHour(12),
      associationIntent: "KEEP",
      reason: "自动复扫解除冲突",
    });
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: conflict.id },
        select: { status: true },
      }),
    ).toEqual({ status: "RESOLVED" });

    const returned = await updateWorkSegment(actor(fixture.member), {
      segmentId: second.segment.id,
      expectedUpdatedAt: moved.segment.updatedAt,
      startAt: atHour(9.25),
      endAt: atHour(10.25),
      associationIntent: "KEEP",
      reason: "自动复扫重开冲突",
    });
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: conflict.id },
        select: { status: true },
      }),
    ).toEqual({ status: "OPEN" });

    await cancelPlannedSegment(actor(fixture.member), {
      segmentId: returned.segment.id,
      expectedUpdatedAt: returned.segment.updatedAt,
      reason: "自动复扫再次解除冲突",
    });
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: conflict.id },
        select: { status: true },
      }),
    ).toEqual({ status: "RESOLVED" });
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: conflict.id,
          action: "pm.conflict.scan",
        },
      }),
    ).toBe(2);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: conflict.id,
          action: "pm.conflict.resolve",
          source: "CRON",
        },
      }),
    ).toBe(2);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:opened:${conflict.fingerprint}` },
          type: "resource_conflict_opened",
        },
      }),
    ).toBe(2);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:resolved:${conflict.id}:` },
          type: "resource_conflict_resolved",
        },
      }),
    ).toBe(2);
    expect(first.segment.id).toBeTruthy();
  });

  test("Conflict opened notification recipients only come from involved segments", async () => {
    const fixture = await createActivatedFixture();
    const unrelatedTask = await createActivatedFixture({
      member: fixture.member,
      title: "P5 Unrelated Recipient Task",
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10, 11, 20),
      taskId: unrelatedTask.taskId,
      nodeId: unrelatedTask.activeNodeId,
    });

    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
      },
    });
    const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey: `pm:conflict:opened:${conflict.fingerprint}:feishu` },
      select: { payload: true },
    });
    const payload = JSON.parse(outbox.payload) as { recipientOpenIds?: string[] };
    expect(payload.recipientOpenIds ?? []).not.toContain(unrelatedTask.owner.openId);
  });

  test("Scanner detects missing allocation, priority, lead role, revision and actual overload rules", async () => {
    const fixture = await createActivatedFixture();
    const otherTask = await createActivatedFixture({
      member: fixture.member,
      title: "P5 Conflict Other Task",
    });

    const missingOverlap = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, null),
      content: "唯一未填写 Allocation",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const filledOverlap = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 40),
      content: "已填写 Allocation 的重叠计划",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 11, 12, 20),
      priority: "CRITICAL",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 11.5, 12.5, 20),
      priority: "HIGH",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 13, 14, 20),
      role: "OWNER",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 13.5, 14.5, 20),
      role: "LEAD",
      taskId: otherTask.taskId,
      nodeId: otherTask.activeNodeId,
    });
    const revisionAffected = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 15, 16, 20),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await prisma.workSegment.update({
      where: { id: revisionAffected.segment.id },
      data: { associationNeedsReview: true },
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 15.5, 16.5, 20),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(17),
      endAt: atHour(18),
      content: "Actual A",
      allocation: 70,
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(17.25),
      endAt: atHour(18.25),
      content: "Actual B",
      allocation: 60,
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });

    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(8),
      endAt: atHour(19),
    });
    const kinds = await prisma.resourceConflict.findMany({
      where: { personId: fixture.member.person.id },
      select: { kind: true },
      distinct: ["kind"],
    });
    expect(kinds.map((item) => item.kind).sort()).toEqual(
      expect.arrayContaining([
        "ACTUAL_OVERLOAD",
        "HIGH_PRIORITY_OVERLAP",
        "LEAD_ROLE_OVERLAP",
        "MISSING_ALLOCATION",
        "REVISION_OVERLAP",
      ]),
    );
    const mixedMissingAllocation = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "MISSING_ALLOCATION",
        startAt: atHour(9.25),
        endAt: atHour(10),
      },
      select: { explanation: true, segments: { select: { segmentId: true } } },
    });
    expect(mixedMissingAllocation.segments.map((entry) => entry.segmentId).sort()).toEqual(
      [missingOverlap.segment.id, filledOverlap.segment.id].sort(),
    );
    const missingExplanation = mixedMissingAllocation.explanation as {
      segmentIds?: string[];
      segments?: Array<{ id?: string }>;
      missingAllocationSegmentIds?: string[];
    };
    expect(missingExplanation.segmentIds?.sort()).toEqual(
      [missingOverlap.segment.id, filledOverlap.segment.id].sort(),
    );
    expect(missingExplanation.segments?.map((segment) => segment.id).sort()).toEqual(
      [missingOverlap.segment.id, filledOverlap.segment.id].sort(),
    );
    expect(missingExplanation.missingAllocationSegmentIds).toEqual([
      missingOverlap.segment.id,
    ]);
  });

  test("Scanner merges continuous slices with the same conflict semantics", async () => {
    const fixture = await createActivatedFixture();
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 12, 20),
      priority: "HIGH",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 12, 20),
      priority: "CRITICAL",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10, 11, 20),
      content: "只贡献切片边界的普通计划",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });

    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(12),
    });
    const conflicts = await prisma.resourceConflict.findMany({
      where: {
        personId: fixture.member.person.id,
        kind: "HIGH_PRIORITY_OVERLAP",
      },
      select: { startAt: true, endAt: true },
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.startAt.toISOString()).toBe(atHour(9).toISOString());
    expect(conflicts[0]?.endAt.toISOString()).toBe(atHour(12).toISOString());
  });

  test("Default window scans keep long-running conflict fingerprints stable", async () => {
    const fixture = await createActivatedFixture();
    const startAt = new Date(Date.UTC(2026, 7, 1, 9, 0, 0));
    const endAt = new Date(Date.UTC(2026, 7, 20, 9, 0, 0));
    await createWorkSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      type: "PLANNED",
      startAt,
      endAt,
      content: "跨扫描窗口计划 A",
      allocation: 70,
      role: "DEVELOPER",
      priority: "MEDIUM",
      tagIds: [],
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      type: "PLANNED",
      startAt,
      endAt,
      content: "跨扫描窗口计划 B",
      allocation: 60,
      role: "DEVELOPER",
      priority: "MEDIUM",
      tagIds: [],
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });

    await scanResourceConflictsForDefaultWindow(
      new Date(Date.UTC(2026, 7, 11, 0, 0, 0)),
    );
    const firstConflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
      },
      select: { fingerprint: true, startAt: true, endAt: true },
    });
    await scanResourceConflictsForDefaultWindow(
      new Date(Date.UTC(2026, 7, 12, 0, 0, 0)),
    );
    const conflicts = await prisma.resourceConflict.findMany({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
      },
      select: { fingerprint: true, startAt: true, endAt: true },
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.fingerprint).toBe(firstConflict.fingerprint);
    expect(conflicts[0]?.startAt.toISOString()).toBe(startAt.toISOString());
    expect(conflicts[0]?.endAt.toISOString()).toBe(endAt.toISOString());
  });

  test("Conflict details only expose segments readable by the actor", async () => {
    const fixture = await createActivatedFixture();
    const otherTask = await createActivatedFixture({
      member: fixture.member,
      title: "P5 Hidden Conflict Task",
    });
    const visibleSegment = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const hiddenSegment = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: otherTask.taskId,
      nodeId: otherTask.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
    });

    const detail = await getResourceConflict({
      actor: actor(fixture.owner),
      input: { conflictId: conflict.id },
    });
    expect(detail.segments).toHaveLength(1);
    expect(detail.segments[0]?.id).toBe(visibleSegment.segment.id);
    expect(detail.hiddenSegmentCount).toBe(1);
    expect(detail.capabilities).toEqual({
      canAcknowledge: false,
      canResolve: false,
      canIgnore: false,
      canPreviewSuggestion: false,
      canApplySuggestion: false,
    });
    const explanation = detail.explanation as {
      hiddenSegmentCount?: number;
      segments?: Array<{ id: string }>;
    };
    expect(explanation.hiddenSegmentCount).toBe(1);
    expect(explanation.segments?.map((segment) => segment.id)).toEqual([
      visibleSegment.segment.id,
    ]);
    const serializedDetail = JSON.stringify(detail);
    expect(serializedDetail).not.toContain(hiddenSegment.segment.id);
    expect(serializedDetail).not.toContain(hiddenSegment.segment.updatedAt);
    expect(serializedDetail).not.toContain(hiddenSegment.segment.content);
    expect(serializedDetail).not.toContain(otherTask.taskId);
    expect(serializedDetail).not.toContain(hiddenSegment.segment.endAt);

    await expectServiceError(
      previewConflictSuggestion(actor(fixture.owner), {
        conflictId: conflict.id,
      }),
      "STATE_CONFLICT",
    );
    await expectServiceError(
      previewConflictSuggestion(actor(fixture.member), {
        conflictId: conflict.id,
      }),
      "STATE_CONFLICT",
    );
    const managerPreview = await previewConflictSuggestion(
      actor(fixture.resourceManager),
      { conflictId: conflict.id },
    );
    expect(managerPreview.suggestions[0]?.moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ segmentId: hiddenSegment.segment.id }),
      ]),
    );

    const hiddenMarkers = [
      `hidden-id=${hiddenSegment.segment.id}`,
      `hidden-content=${hiddenSegment.segment.content}`,
      `hidden-task=${otherTask.taskId}`,
      `hidden-start=${hiddenSegment.segment.startAt}`,
      `hidden-end=${hiddenSegment.segment.endAt}`,
      `hidden-version=${hiddenSegment.segment.updatedAt}`,
    ];
    const sensitiveHandlingText = hiddenMarkers.join(" | ");
    await resolveConflict(actor(fixture.resourceManager), {
      conflictId: conflict.id,
      resolutionNote: sensitiveHandlingText,
      changedSegmentIds: [visibleSegment.segment.id, hiddenSegment.segment.id],
    });
    const resolvedDetail = await getResourceConflict({
      actor: actor(fixture.owner),
      input: { conflictId: conflict.id },
    });
    const resolvedExplanation = resolvedDetail.explanation as {
      changedSegmentIds?: string[];
    };
    expect(resolvedExplanation.changedSegmentIds).toEqual([
      visibleSegment.segment.id,
    ]);
    expect(resolvedDetail.resolutionNote).toBe("处理说明涉及不可见记录，已隐藏");
    expect(resolvedExplanation).toMatchObject({
      resolutionNote: "处理说明涉及不可见记录，已隐藏",
    });
    const resolvedViewerList = await listResourceConflicts({
      actor: actor(fixture.viewer),
      input: { personId: fixture.member.person.id },
    });
    const resolvedViewerListItem = resolvedViewerList.items.find(
      (item) => item.id === conflict.id,
    );
    if (!resolvedViewerListItem) throw new Error("列表缺少目标资源冲突");
    for (const partialDto of [resolvedDetail, resolvedViewerListItem]) {
      const serialized = JSON.stringify(partialDto);
      for (const marker of hiddenMarkers) expect(serialized).not.toContain(marker);
    }
    const fullResolvedDetail = await getResourceConflict({
      actor: actor(fixture.resourceManager, [
        { role: "RESOURCE_MANAGER", team: "英雄", techGroup: "电控" },
      ]),
      input: { conflictId: conflict.id },
    });
    expect(fullResolvedDetail.resolutionNote).toBe(sensitiveHandlingText);
    expect(fullResolvedDetail.explanation).toMatchObject({
      resolutionNote: sensitiveHandlingText,
    });

    await prisma.resourceConflict.update({
      where: { id: conflict.id },
      data: { status: "OPEN", resolvedAt: null },
    });
    await ignoreConflict(actor(fixture.resourceManager), {
      conflictId: conflict.id,
      reason: sensitiveHandlingText,
      ignoredUntil: atHour(20),
    });
    const ignoredViewerDetail = await getResourceConflict({
      actor: actor(fixture.viewer),
      input: { conflictId: conflict.id },
    });
    const ignoredViewerList = await listResourceConflicts({
      actor: actor(fixture.viewer),
      input: { personId: fixture.member.person.id },
    });
    const ignoredViewerListItem = ignoredViewerList.items.find(
      (item) => item.id === conflict.id,
    );
    expect(ignoredViewerDetail.resolutionNote).toBe(
      "处理说明涉及不可见记录，已隐藏",
    );
    expect(ignoredViewerDetail.explanation).toMatchObject({
      resolutionNote: "处理说明涉及不可见记录，已隐藏",
      ignoredReason: "处理说明涉及不可见记录，已隐藏",
    });
    if (!ignoredViewerListItem) throw new Error("列表缺少目标资源冲突");
    for (const partialDto of [ignoredViewerDetail, ignoredViewerListItem]) {
      const serialized = JSON.stringify(partialDto);
      for (const marker of hiddenMarkers) expect(serialized).not.toContain(marker);
    }
    const fullIgnoredDetail = await getResourceConflict({
      actor: actor(fixture.resourceManager, [
        { role: "RESOURCE_MANAGER", team: "英雄", techGroup: "电控" },
      ]),
      input: { conflictId: conflict.id },
    });
    expect(fullIgnoredDetail.resolutionNote).toBe(sensitiveHandlingText);
    expect(fullIgnoredDetail.explanation).toMatchObject({
      resolutionNote: sensitiveHandlingText,
      ignoredReason: sensitiveHandlingText,
    });
  });

  test("Missing-allocation list and detail DTOs redact every hidden Segment evidence field", async () => {
    const fixture = await createActivatedFixture({
      title: "P5 Missing Allocation DTO Redaction",
    });
    const hiddenTask = await createActivatedFixture({
      member: fixture.member,
      title: "P5 Hidden Missing Allocation Task",
    });
    const visibleSegment = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 50),
      content: "部分可见的 allocation 证据",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const hiddenSegment = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 11, null),
      content: `隐藏 allocation 证据 ${randomUUID()}`,
      taskId: hiddenTask.taskId,
      nodeId: hiddenTask.activeNodeId,
    });
    const hiddenVersion = new Date("2026-06-03T04:05:06.789Z");
    await prisma.workSegment.update({
      where: { id: hiddenSegment.segment.id },
      data: { updatedAt: hiddenVersion },
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "MISSING_ALLOCATION",
      },
    });
    const partialActor = actor(fixture.owner);
    const partialDetail = await getResourceConflict({
      actor: partialActor,
      input: { conflictId: conflict.id },
    });
    const partialList = await listResourceConflicts({
      actor: partialActor,
      input: {
        personId: fixture.member.person.id,
        kind: "MISSING_ALLOCATION",
      },
    });
    const partialListItem = partialList.items.find(
      (item) => item.id === conflict.id,
    );
    if (!partialListItem) throw new Error("列表缺少 allocation 缺失冲突");
    for (const partialDto of [partialDetail, partialListItem]) {
      expect(partialDto.hiddenSegmentCount).toBe(1);
      expect(partialDto.segments.map((segment) => segment.id)).toEqual([
        visibleSegment.segment.id,
      ]);
      expect(partialDto.explanation).toMatchObject({
        segmentIds: [visibleSegment.segment.id],
        missingAllocationSegmentIds: [],
        segments: [expect.objectContaining({ id: visibleSegment.segment.id })],
      });
      const serialized = JSON.stringify(partialDto);
      for (const hiddenMarker of [
        hiddenSegment.segment.id,
        hiddenTask.taskId,
        hiddenSegment.segment.content,
        atHour(9).toISOString(),
        atHour(11).toISOString(),
        hiddenVersion.toISOString(),
      ]) {
        expect(serialized).not.toContain(hiddenMarker);
      }
    }

    const fullActor = actor(fixture.resourceManager, [
      { role: "RESOURCE_MANAGER", team: "英雄", techGroup: "电控" },
    ]);
    const fullDetail = await getResourceConflict({
      actor: fullActor,
      input: { conflictId: conflict.id },
    });
    expect(fullDetail.hiddenSegmentCount).toBe(0);
    expect(fullDetail.segments.map((segment) => segment.id).sort()).toEqual(
      [visibleSegment.segment.id, hiddenSegment.segment.id].sort(),
    );
    expect(fullDetail.explanation).toMatchObject({
      segmentIds: expect.arrayContaining([
        visibleSegment.segment.id,
        hiddenSegment.segment.id,
      ]),
      missingAllocationSegmentIds: [hiddenSegment.segment.id],
      segments: expect.arrayContaining([
        expect.objectContaining({ id: visibleSegment.segment.id }),
        expect.objectContaining({ id: hiddenSegment.segment.id }),
      ]),
    });
  });

  test("Conflict capabilities follow actor permissions and conflict status", async () => {
    const fixture = await createActivatedFixture();
    const systemAdmin = await createAccountPerson("P5 Conflict System Admin");
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      select: { id: true },
    });
    const scopedManagerActor = actor(fixture.resourceManager, [
      { role: "RESOURCE_MANAGER", team: "英雄", techGroup: "电控" },
    ]);
    const systemAdminActor = actor(systemAdmin, [
      { role: "SYSTEM_ADMINISTRATOR", team: "", techGroup: "" },
    ]);
    const noCapabilities = {
      canAcknowledge: false,
      canResolve: false,
      canIgnore: false,
      canPreviewSuggestion: false,
      canApplySuggestion: false,
    };
    const handlerOpenCapabilities = {
      canAcknowledge: true,
      canResolve: true,
      canIgnore: true,
      canPreviewSuggestion: true,
      canApplySuggestion: true,
    };

    const openSelf = await getResourceConflict({
      actor: actor(fixture.member),
      input: { conflictId: conflict.id },
    });
    expect(openSelf.capabilities).toEqual({
      ...noCapabilities,
      canAcknowledge: true,
    });
    for (const handlingActor of [
      actor(fixture.owner),
      scopedManagerActor,
      systemAdminActor,
    ]) {
      const detail = await getResourceConflict({
        actor: handlingActor,
        input: { conflictId: conflict.id },
      });
      expect(detail.capabilities).toEqual(handlerOpenCapabilities);
    }
    const openViewer = await getResourceConflict({
      actor: actor(fixture.viewer),
      input: { conflictId: conflict.id },
    });
    expect(openViewer.capabilities).toEqual(noCapabilities);

    const list = await listResourceConflicts({
      actor: scopedManagerActor,
      input: { personId: fixture.member.person.id },
    });
    expect(list.items.find((item) => item.id === conflict.id)?.capabilities).toEqual(
      handlerOpenCapabilities,
    );

    await prisma.resourceConflict.update({
      where: { id: conflict.id },
      data: { status: "ACKNOWLEDGED" },
    });
    const acknowledged = await getResourceConflict({
      actor: scopedManagerActor,
      input: { conflictId: conflict.id },
    });
    expect(acknowledged.capabilities).toEqual(handlerOpenCapabilities);

    await prisma.resourceConflict.update({
      where: { id: conflict.id },
      data: { status: "IGNORED" },
    });
    const ignored = await getResourceConflict({
      actor: systemAdminActor,
      input: { conflictId: conflict.id },
    });
    expect(ignored.capabilities).toEqual({
      ...handlerOpenCapabilities,
      canAcknowledge: false,
    });

    await prisma.resourceConflict.update({
      where: { id: conflict.id },
      data: { status: "RESOLVED" },
    });
    for (const resolvedActor of [actor(fixture.member), actor(fixture.viewer)]) {
      const detail = await getResourceConflict({
        actor: resolvedActor,
        input: { conflictId: conflict.id },
      });
      expect(detail.capabilities).toEqual(noCapabilities);
    }
    for (const resolvedHandler of [
      actor(fixture.owner),
      scopedManagerActor,
      systemAdminActor,
    ]) {
      const detail = await getResourceConflict({
        actor: resolvedHandler,
        input: { conflictId: conflict.id },
      });
      expect(detail.capabilities).toEqual({
        ...noCapabilities,
        canResolve: true,
        canPreviewSuggestion: true,
      });
    }
  });

  test("Conflict capabilities match each service state contract", async () => {
    const fixture = await createActivatedFixture();
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      select: { id: true },
    });
    const managerQueryActor = actor(fixture.resourceManager, [
      { role: "RESOURCE_MANAGER", team: "英雄", techGroup: "电控" },
    ]);
    const statusCases = [
      {
        status: "OPEN" as const,
        expected: {
          canAcknowledge: true,
          canResolve: true,
          canIgnore: true,
          canPreviewSuggestion: true,
          canApplySuggestion: true,
        },
      },
      {
        status: "ACKNOWLEDGED" as const,
        expected: {
          canAcknowledge: true,
          canResolve: true,
          canIgnore: true,
          canPreviewSuggestion: true,
          canApplySuggestion: true,
        },
      },
      {
        status: "IGNORED" as const,
        expected: {
          canAcknowledge: false,
          canResolve: true,
          canIgnore: true,
          canPreviewSuggestion: true,
          canApplySuggestion: true,
        },
      },
      {
        status: "RESOLVED" as const,
        expected: {
          canAcknowledge: false,
          canResolve: true,
          canIgnore: false,
          canPreviewSuggestion: true,
          canApplySuggestion: false,
        },
      },
    ];

    for (const { status, expected } of statusCases) {
      await setConflictStatus(conflict.id, status);
      const detail = await getResourceConflict({
        actor: managerQueryActor,
        input: { conflictId: conflict.id },
      });
      expect(detail.capabilities).toEqual(expected);

      await setConflictStatus(conflict.id, status);
      await expectServiceAcceptance(
        acknowledgeConflict(actor(fixture.resourceManager), {
          conflictId: conflict.id,
          note: `状态契约 ${status}`,
        }),
        expected.canAcknowledge,
      );

      await setConflictStatus(conflict.id, status);
      await expectServiceAcceptance(
        resolveConflict(actor(fixture.resourceManager), {
          conflictId: conflict.id,
          resolutionNote: `状态契约 ${status}`,
        }),
        expected.canResolve,
      );

      await setConflictStatus(conflict.id, status);
      await expectServiceAcceptance(
        ignoreConflict(actor(fixture.resourceManager), {
          conflictId: conflict.id,
          reason: `状态契约 ${status}`,
          ignoredUntil: atHour(20),
        }),
        expected.canIgnore,
      );

      await setConflictStatus(conflict.id, status);
      const previewCall = previewConflictSuggestion(actor(fixture.resourceManager), {
        conflictId: conflict.id,
      });
      await expectServiceAcceptance(previewCall, expected.canPreviewSuggestion);
      if (status === "RESOLVED") {
        await expect(previewCall).resolves.toEqual({
          conflictId: conflict.id,
          suggestions: [],
        });
      }

      await setConflictStatus(conflict.id, "OPEN");
      const previewForApply = await previewConflictSuggestion(
        actor(fixture.resourceManager),
        { conflictId: conflict.id },
      );
      const proposal = previewForApply.suggestions[0];
      if (!proposal) throw new Error("未生成资源冲突处理建议");
      await setConflictStatus(conflict.id, status);
      await expectServiceAcceptance(
        applyConflictSuggestion(actor(fixture.resourceManager), {
          conflictId: conflict.id,
          confirmApply: true,
          proposal,
        }),
        expected.canApplySuggestion,
      );
    }
  });

  test("Task owner applies suggestions for owned Tasks without gaining ordinary Segment management", async () => {
    const fixture = await createActivatedFixture();
    const alsoOwnedTask = await createActivatedFixture({
      owner: fixture.owner,
      member: fixture.member,
      title: "P5 Same Owner Conflict Task",
    });
    const first = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const second = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: alsoOwnedTask.taskId,
      nodeId: alsoOwnedTask.activeNodeId,
    });
    const third = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 10),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      select: { id: true },
    });

    const detail = await getResourceConflict({
      actor: actor(fixture.owner),
      input: { conflictId: conflict.id },
    });
    expect(detail.hiddenSegmentCount).toBe(0);
    expect(detail.capabilities).toEqual({
      canAcknowledge: true,
      canResolve: true,
      canIgnore: true,
      canPreviewSuggestion: true,
      canApplySuggestion: true,
    });
    const preview = await previewConflictSuggestion(actor(fixture.owner), {
      conflictId: conflict.id,
    });
    const proposal = preview.suggestions[0];
    if (!proposal) throw new Error("Task Owner 未获得冲突处理建议");
    expect(proposal.moves.length).toBeGreaterThan(0);

    const conflictSegmentIds = [
      first.segment.id,
      second.segment.id,
      third.segment.id,
    ].sort();
    const beforeDeniedOperations = await conflictApplyWriteState(
      conflict.id,
      conflictSegmentIds,
    );
    await expectServiceError(
      movePlannedSegments(actor(fixture.owner), {
        moves: proposal.moves,
        reason: "Task Owner 尝试普通移动他人 Segment",
      }),
      "FORBIDDEN",
    );
    expect(
      await conflictApplyWriteState(conflict.id, conflictSegmentIds),
    ).toEqual(beforeDeniedOperations);

    await expectServiceError(
      applyConflictSuggestion(actor(fixture.outsider), {
        conflictId: conflict.id,
        confirmApply: true,
        proposal,
      }),
      "NOT_FOUND",
    );
    expect(
      await conflictApplyWriteState(conflict.id, conflictSegmentIds),
    ).toEqual(beforeDeniedOperations);

    expect(proposal.moves).toHaveLength(2);
    const firstMove = proposal.moves[0];
    if (!firstMove) throw new Error("Task Owner 建议缺少首条 move");
    const shiftedStartAt = new Date(
      new Date(firstMove.startAt).getTime() + 60_000,
    ).toISOString();
    const shiftedEndAt = new Date(
      new Date(firstMove.endAt).getTime() + 60_000,
    ).toISOString();
    const staleExpectedUpdatedAt = new Date(
      new Date(firstMove.expectedUpdatedAt).getTime() - 1,
    ).toISOString();
    const rejectedProposals = [
      {
        label: "篡改 canonical 时间",
        expectedCode: "STATE_CONFLICT" as const,
        proposal: {
          ...proposal,
          moves: proposal.moves.map((move, index) =>
            index === 0
              ? { ...move, startAt: shiftedStartAt, endAt: shiftedEndAt }
              : move,
          ),
        },
      },
      {
        label: "空 move set",
        expectedCode: "STATE_CONFLICT" as const,
        proposal: { ...proposal, moves: [] },
      },
      {
        label: "缺失 canonical move",
        expectedCode: "STATE_CONFLICT" as const,
        proposal: { ...proposal, moves: proposal.moves.slice(0, -1) },
      },
      {
        label: "额外 move",
        expectedCode: "STATE_CONFLICT" as const,
        proposal: { ...proposal, moves: [...proposal.moves, firstMove] },
      },
      {
        label: "重排 canonical moves",
        expectedCode: "STATE_CONFLICT" as const,
        proposal: { ...proposal, moves: [...proposal.moves].reverse() },
      },
      {
        label: "错误 proposalId",
        expectedCode: "STATE_CONFLICT" as const,
        proposal: { ...proposal, proposalId: "forged-proposal" },
      },
      {
        label: "陈旧 expectedUpdatedAt",
        expectedCode: "STALE_SEGMENT" as const,
        proposal: {
          ...proposal,
          moves: proposal.moves.map((move, index) =>
            index === 0
              ? { ...move, expectedUpdatedAt: staleExpectedUpdatedAt }
              : move,
          ),
        },
      },
    ];
    for (const rejected of rejectedProposals) {
      const beforeRejectedApply = await conflictApplyWriteState(
        conflict.id,
        conflictSegmentIds,
      );
      await expectServiceError(
        applyConflictSuggestion(actor(fixture.owner), {
          conflictId: conflict.id,
          confirmApply: true,
          proposal: rejected.proposal,
        }),
        rejected.expectedCode,
      );
      expect(
        await conflictApplyWriteState(conflict.id, conflictSegmentIds),
        rejected.label,
      ).toEqual(beforeRejectedApply);
    }

    const applied = await applyConflictSuggestion(actor(fixture.owner), {
      conflictId: conflict.id,
      confirmApply: true,
      proposal,
    });
    expect(applied.status).toBe("RESOLVED");
    expect(applied.movedSegments.affectedSegmentIds.sort()).toEqual(
      proposal.moves.map((move) => move.segmentId).sort(),
    );
    const moveById = new Map(
      proposal.moves.map((move) => [move.segmentId, move]),
    );
    const persistedMovedSegments = await prisma.workSegment.findMany({
      where: { id: { in: applied.movedSegments.affectedSegmentIds } },
      select: {
        id: true,
        startAt: true,
        endAt: true,
        updatedByAccountId: true,
      },
      orderBy: { id: "asc" },
    });
    for (const segment of persistedMovedSegments) {
      const move = moveById.get(segment.id);
      if (!move) throw new Error("Owner apply 移动了冲突范围外 Segment");
      expect(segment).toMatchObject({
        startAt: new Date(move.startAt),
        endAt: new Date(move.endAt),
        updatedByAccountId: fixture.owner.account.id,
      });
    }
    expect(
      await prisma.workSegmentChange.findMany({
        where: {
          segmentId: { in: applied.movedSegments.affectedSegmentIds },
          action: "UPDATE",
          reason: "应用资源冲突处理建议",
        },
        select: { segmentId: true, actorAccountId: true },
        orderBy: { segmentId: "asc" },
      }),
    ).toEqual(
      applied.movedSegments.affectedSegmentIds
        .sort()
        .map((segmentId) => ({
          segmentId,
          actorAccountId: fixture.owner.account.id,
        })),
    );
    const segmentAudits = await prisma.domainAuditEvent.findMany({
      where: {
        entityType: "WorkSegment",
        entityId: { in: applied.movedSegments.affectedSegmentIds },
        action: "pm.segment.update",
        reason: "应用资源冲突处理建议",
      },
      select: { entityId: true, actorAccountId: true, actorPersonId: true },
      orderBy: { entityId: "asc" },
    });
    expect(segmentAudits).toEqual(
      applied.movedSegments.affectedSegmentIds
        .sort()
        .map((entityId) => ({
          entityId,
          actorAccountId: fixture.owner.account.id,
          actorPersonId: fixture.owner.person.id,
        })),
    );
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: conflict.id },
        select: { status: true, resolvedByAccountId: true, resolutionNote: true },
      }),
    ).toEqual({
      status: "RESOLVED",
      resolvedByAccountId: fixture.owner.account.id,
      resolutionNote: "已应用资源冲突处理建议",
    });
    expect(
      await prisma.domainAuditEvent.findFirstOrThrow({
        where: {
          entityType: "ResourceConflict",
          entityId: conflict.id,
          action: "pm.conflict.apply_suggestion",
        },
        select: { actorAccountId: true, actorPersonId: true, source: true },
      }),
    ).toEqual({
      actorAccountId: fixture.owner.account.id,
      actorPersonId: fixture.owner.person.id,
      source: "WEB",
    });
    const resolvedPayload = await expectProjectManagementOutbox(
      `pm:conflict:resolved:${conflict.id}:`,
      "resource_conflict_resolved",
      true,
    );
    expect(resolvedPayload.actorName).toBe(fixture.owner.person.displayName);

    const afterApply = await conflictApplyWriteState(
      conflict.id,
      conflictSegmentIds,
    );
    await expectServiceError(
      applyConflictSuggestion(actor(fixture.owner), {
        conflictId: conflict.id,
        confirmApply: true,
        proposal,
      }),
      "STATE_CONFLICT",
    );
    expect(
      await conflictApplyWriteState(conflict.id, conflictSegmentIds),
    ).toEqual(afterApply);
  });

  test("Scoped manager cannot handle a conflict when only some Tasks match scope", async () => {
    const fixture = await createActivatedFixture();
    const outOfScopeTask = await createActivatedFixture({
      member: fixture.member,
      title: "P5 Out Of Scope Conflict Task",
      team: "步兵",
      techGroup: "机械",
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: outOfScopeTask.taskId,
      nodeId: outOfScopeTask.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      select: { id: true },
    });
    const scopedManagerActor = actor(fixture.resourceManager, [
      { role: "RESOURCE_MANAGER", team: "英雄", techGroup: "电控" },
    ]);

    const detail = await getResourceConflict({
      actor: scopedManagerActor,
      input: { conflictId: conflict.id },
    });
    expect(detail.hiddenSegmentCount).toBe(1);
    expect(detail.capabilities).toEqual({
      canAcknowledge: false,
      canResolve: false,
      canIgnore: false,
      canPreviewSuggestion: false,
      canApplySuggestion: false,
    });
    const list = await listResourceConflicts({
      actor: scopedManagerActor,
      input: { personId: fixture.member.person.id },
    });
    expect(list.items.find((item) => item.id === conflict.id)).toMatchObject({
      hiddenSegmentCount: 1,
      capabilities: detail.capabilities,
    });
    await expectServiceError(
      previewConflictSuggestion(actor(fixture.resourceManager), {
        conflictId: conflict.id,
      }),
      "STATE_CONFLICT",
    );
  });

  test("Explicit person prevalidation rejects an invalid person before any conflict writes", async () => {
    const fixture = await createActivatedFixture();
    const inactivePerson = await prisma.person.create({
      data: { displayName: "P5 Invalid Explicit Scan Person", status: "INACTIVE" },
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const before = await conflictWriteCounts(fixture.member.person.id);

    await expectServiceError(
      scanResourceConflicts({
        personIds: [
          fixture.member.person.id,
          inactivePerson.id,
          randomUUID(),
        ],
        startAt: atHour(9),
        endAt: atHour(11),
      }),
      "VALIDATION_ERROR",
    );

    expect(await conflictWriteCounts(fixture.member.person.id)).toEqual(before);
  });

  test("A runtime failure for one person is observable and does not stop later people", async () => {
    const systemAdmin = await createAccountPerson("P5 Partial Scan System Admin");
    await grantRole(systemAdmin.account.id, "SYSTEM_ADMINISTRATOR");
    const people = await Promise.all([
      createAccountPerson("P5 Partial Scan A"),
      createAccountPerson("P5 Partial Scan B"),
      createAccountPerson("P5 Partial Scan C"),
    ]);
    const sortedPeople = [...people].sort((left, right) =>
      left.person.id.localeCompare(right.person.id),
    );
    for (const [index, person] of sortedPeople.entries()) {
      await createWorkSegment(actor(systemAdmin), {
        ...plannedInput(person.person.id, 9, 10, 70),
        content: `逐人失败隔离 A-${index}`,
      });
      await createWorkSegment(actor(systemAdmin), {
        ...plannedInput(person.person.id, 9.25, 10.25, 60),
        content: `逐人失败隔离 B-${index}`,
      });
    }
    const middlePerson = sortedPeople[1];
    if (!middlePerson) throw new Error("缺少中间扫描人员");
    const successfulPersonIds = sortedPeople
      .filter((person) => person.person.id !== middlePerson.person.id)
      .map((person) => person.person.id)
      .sort();
    let locker: Client | undefined;
    let observer: Client | undefined;
    let transactionMayBeOpen = false;
    let lockerReleased = false;
    let scanPromise: ReturnType<typeof scanResourceConflicts> | undefined;
    let scanSettlement:
      | Promise<
          PromiseSettledResult<
            Awaited<ReturnType<typeof scanResourceConflicts>>
          >[]
        >
      | undefined;
    let pendingBackendPids: number[] = [];
    let scanHandled = false;
    let scanLogEntries: Record<string, unknown>[] = [];
    let primaryError: unknown;
    let hasPrimaryError = false;
    try {
      locker = await connectDatabaseClient("partial-scan-locker");
      observer = await connectDatabaseClient("partial-scan-observer");
      transactionMayBeOpen = true;
      const lockerPid = await lockConflictPerson(locker, middlePerson.person.id);
      const started = startBarrierOperations([
        async () => {
          const captured = await captureStructuredLogs(() =>
            scanResourceConflicts({
              personIds: sortedPeople
                .map((person) => person.person.id)
                .reverse(),
              startAt: atHour(9),
              endAt: atHour(11),
            }),
          );
          scanLogEntries = captured.entries;
          return captured.result;
        },
      ]);
      scanPromise = started.pending[0];
      scanSettlement = started.settlement;
      if (!scanPromise) throw new Error("逐人扫描 promise 未创建");
      const [blockedPid] = await waitForDirectBlockers(observer, lockerPid, 1);
      if (!blockedPid) throw new Error("未观察到中间人员扫描锁等待");
      pendingBackendPids = [blockedPid];
      const cancellation = await observer.query<{ cancelled: boolean }>(
        "SELECT pg_cancel_backend($1) AS cancelled",
        [blockedPid],
      );
      expect(cancellation.rows[0]?.cancelled).toBe(true);
      await waitForBackendToLeaveLockWait(observer, lockerPid, blockedPid);
      const result = await scanPromise;
      scanHandled = true;
      await locker.query("COMMIT");
      lockerReleased = true;
      expect(result).toMatchObject({
        scannedPersonCount: 3,
        succeededPersonCount: 2,
        failedPersonCount: 1,
        createdCount: 0,
      });
      expect(result.results.map((entry) => entry.personId).sort()).toEqual(
        successfulPersonIds,
      );
      expect(result.failures).toEqual([
        {
          personId: middlePerson.person.id,
          code: "INTERNAL_ERROR",
          message: "操作失败，请稍后重试",
        },
      ]);
      expect(Object.keys(result.failures[0] ?? {}).sort()).toEqual([
        "code",
        "message",
        "personId",
      ]);
      const failureLogs = scanLogEntries.filter(
        (entry) =>
          entry.event ===
          "project_management.resource_conflicts.scan.person_failed",
      );
      expect(failureLogs).toHaveLength(1);
      const failureLog = failureLogs[0];
      expect(failureLog).toMatchObject({
        module: "project-management",
        action: "scanResourceConflicts",
        personId: middlePerson.person.id,
        result: "failure",
        errorCode: "INTERNAL_ERROR",
        errorMessage: "操作失败，请稍后重试",
        level: "error",
      });
      expect(failureLog).not.toHaveProperty("error");
      expect(failureLog).not.toHaveProperty("stack");
      const serializedFailureLog = JSON.stringify(failureLog);
      expect(serializedFailureLog).not.toContain(
        "canceling statement due to user request",
      );
      expect(serializedFailureLog).not.toContain("PrismaClient");
      expect(
        await prisma.resourceConflict.count({
          where: {
            personId: {
              in: successfulPersonIds,
            },
            kind: "ALLOCATION_OVER_LIMIT",
          },
        }),
      ).toBe(2);
      expect(
        await prisma.resourceConflict.count({
          where: { personId: middlePerson.person.id },
        }),
      ).toBe(0);
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
    }
    const cleanupErrors = await cleanupBarrierResources({
      locker,
      observer,
      rollbackRequired: Boolean(
        locker && transactionMayBeOpen && !lockerReleased,
      ),
      pendingSettlement: scanSettlement,
      pendingBackendPids,
      pendingHandled: scanHandled,
      primaryError,
    });
    throwBarrierErrors(hasPrimaryError, primaryError, cleanupErrors);
  });

  test("Conflict scans are idempotent, resolve obsolete conflicts and reopen expired ignored conflicts", async () => {
    const fixture = await createActivatedFixture();
    const first = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const second = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const scan = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    expect(scan.createdCount).toBe(0);
    expect(scan.unchangedCount).toBe(1);
    const repeated = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    expect(repeated.createdCount).toBe(0);
    expect(
      await prisma.resourceConflict.count({
        where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      }),
    ).toBe(1);

    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      include: { segments: true },
    });
    await ignoreConflict(actor(fixture.resourceManager), {
      conflictId: conflict.id,
      reason: "短期接受风险",
      ignoredUntil: atHour(20),
    });
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:resolved:${conflict.id}:` },
          type: "resource_conflict_resolved",
        },
      }),
    ).toBe(0);
    const ignoredScan = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    expect(ignoredScan.reopenedCount).toBe(0);
    await prisma.resourceConflict.update({
      where: { id: conflict.id },
      data: { ignoredUntil: new Date("2026-07-27T08:00:00.000Z") },
    });
    const reopenedScans = await runBehindPersonLockBarrier(
      fixture.member.person.id,
      [
        () =>
          scanConflictsForPerson({
            personId: fixture.member.person.id,
            startAt: atHour(9),
            endAt: atHour(11),
          }),
        () =>
          scanConflictsForPerson({
            personId: fixture.member.person.id,
            startAt: atHour(9),
            endAt: atHour(11),
          }),
      ],
    );
    expect(
      reopenedScans.reduce((sum, result) => sum + result.reopenedCount, 0),
    ).toBe(1);
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: conflict.id },
        select: { status: true },
      }),
    ).toEqual({ status: "OPEN" });
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: conflict.id,
          action: "pm.conflict.scan",
        },
      }),
    ).toBe(2);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:opened:${conflict.fingerprint}` },
          type: "resource_conflict_opened",
        },
      }),
    ).toBe(2);

    await movePlannedSegments(actor(fixture.member), {
      moves: [
        {
          segmentId: second.segment.id,
          expectedUpdatedAt: second.segment.updatedAt,
          startAt: atHour(11),
          endAt: atHour(12),
        },
      ],
      reason: "手动移开冲突",
    });
    const resolvedScan = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(12),
    });
    expect(resolvedScan.resolvedCount).toBe(0);
    const resolved = await prisma.resourceConflict.findUniqueOrThrow({
      where: { id: conflict.id },
      select: { status: true },
    });
    expect(resolved.status).toBe("RESOLVED");
    const scannerResolvedPayload = await expectProjectManagementOutbox(
      `pm:conflict:resolved:${conflict.id}:`,
      "resource_conflict_resolved",
      true,
    );
    expect(scannerResolvedPayload.actorName).toBe("系统");
    const scannerResolvedInApp =
      await prisma.inAppNotification.findFirstOrThrow({
        where: {
          eventKey: { startsWith: `pm:conflict:resolved:${conflict.id}:` },
        },
        select: { payload: true },
      });
    expect(
      (scannerResolvedInApp.payload as Record<string, unknown>).actorName,
    ).toBe("系统");
    expect(first.segment.id).toBeTruthy();
  });

  test("A genuine scanner resolution reopens a returning fingerprint once with exactly-once history, audit and outbox", async () => {
    const cycle = await createOpenAllocationConflict({
      title: "P5 Genuine Scanner Resolution Provenance",
      startHour: 9,
    });
    const movedAway = await movePlannedSegments(actor(cycle.fixture.member), {
      moves: [
        {
          segmentId: cycle.second.segment.id,
          expectedUpdatedAt: cycle.second.segment.updatedAt,
          startAt: atHour(11),
          endAt: atHour(12),
        },
      ],
      reason: "让原 fingerprint 经 scanner 自动解决",
    });

    const resolvedScan = await scanConflictsForPerson(cycle.range);
    expect(resolvedScan.resolvedCount).toBe(0);
    const [resolvedConflict, resolutionAudit] = await Promise.all([
      prisma.resourceConflict.findUniqueOrThrow({
        where: { id: cycle.conflict.id },
        select: { status: true, resolvedAt: true },
      }),
      prisma.domainAuditEvent.findFirstOrThrow({
        where: {
          entityType: "ResourceConflict",
          entityId: cycle.conflict.id,
          action: "pm.conflict.resolve",
          source: "CRON",
        },
        select: { createdAt: true },
      }),
    ]);
    expect(resolvedConflict.status).toBe("RESOLVED");
    if (!resolvedConflict.resolvedAt) throw new Error("scanner 未记录 resolvedAt");
    expect(resolutionAudit.createdAt.getTime()).toBe(
      resolvedConflict.resolvedAt.getTime(),
    );

    const movedSecond = movedAway.segments.find(
      (segment) => segment.id === cycle.second.segment.id,
    );
    if (!movedSecond) throw new Error("未返回移出冲突区间的 Segment");
    await movePlannedSegments(actor(cycle.fixture.member), {
      moves: [
        {
          segmentId: cycle.second.segment.id,
          expectedUpdatedAt: movedSecond.updatedAt,
          startAt: cycle.second.segment.startAt,
          endAt: cycle.second.segment.endAt,
        },
      ],
      reason: "恢复原 fingerprint",
    });

    const reopenScans = await runBehindPersonLockBarrier(
      cycle.fixture.member.person.id,
      [
        () => scanConflictsForPerson(cycle.range),
        () => scanConflictsForPerson(cycle.range),
      ],
    );
    expect(
      reopenScans.reduce((sum, result) => sum + result.reopenedCount, 0),
    ).toBe(0);
    expect(
      reopenScans.reduce((sum, result) => sum + result.unchangedCount, 0),
    ).toBe(2);
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: cycle.conflict.id },
        select: {
          status: true,
          resolvedAt: true,
          resolvedByAccountId: true,
          resolutionNote: true,
        },
      }),
    ).toEqual({
      status: "OPEN",
      resolvedAt: null,
      resolvedByAccountId: null,
      resolutionNote: "",
    });
    expect(
      await prisma.resourceConflict.count({
        where: { fingerprint: cycle.conflict.fingerprint },
      }),
    ).toBe(1);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: cycle.conflict.id,
        },
      }),
    ).toBe(3);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: cycle.conflict.id,
          action: "pm.conflict.resolve",
          source: "CRON",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: {
            startsWith: `pm:conflict:opened:${cycle.conflict.fingerprint}`,
          },
          type: "resource_conflict_opened",
        },
      }),
    ).toBe(2);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:resolved:${cycle.conflict.id}:` },
          type: "resource_conflict_resolved",
        },
      }),
    ).toBe(1);
  });

  test("A unique legacy CRON audit strictly after resolvedAt reopens once, while manual resolve remains terminal", async () => {
    const legacyFixture = await createActivatedFixture({
      title: "P5 Legacy Resolution Provenance",
    });
    await createWorkSegment(actor(legacyFixture.member), {
      ...plannedInput(legacyFixture.member.person.id, 9, 10, 70),
      taskId: legacyFixture.taskId,
      nodeId: legacyFixture.activeNodeId,
    });
    const movable = await createWorkSegment(actor(legacyFixture.member), {
      ...plannedInput(legacyFixture.member.person.id, 9.25, 10.25, 60),
      taskId: legacyFixture.taskId,
      nodeId: legacyFixture.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: legacyFixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(12),
    });
    const legacyConflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: legacyFixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
      },
    });
    await ignoreConflict(actor(legacyFixture.resourceManager), {
      conflictId: legacyConflict.id,
      reason: "模拟旧版 ignore 后自动解决",
      ignoredUntil: atHour(20),
    });
    await prisma.resourceConflict.update({
      where: { id: legacyConflict.id },
      data: { ignoredUntil: new Date("2026-07-27T08:00:00.000Z") },
    });
    const movedAway = await movePlannedSegments(actor(legacyFixture.member), {
      moves: [
        {
          segmentId: movable.segment.id,
          expectedUpdatedAt: movable.segment.updatedAt,
          startAt: atHour(11),
          endAt: atHour(12),
        },
      ],
      reason: "让旧版 ignored conflict 被 scanner 自动解决",
    });
    const autoResolved = await scanConflictsForPerson({
      personId: legacyFixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(12),
    });
    expect(autoResolved.resolvedCount).toBe(0);
    const [autoResolvedRow, autoResolutionAudit] = await Promise.all([
      prisma.resourceConflict.findUniqueOrThrow({
        where: { id: legacyConflict.id },
        select: { resolvedAt: true },
      }),
      prisma.domainAuditEvent.findFirstOrThrow({
        where: {
          entityType: "ResourceConflict",
          entityId: legacyConflict.id,
          action: "pm.conflict.resolve",
          source: "CRON",
        },
        select: { createdAt: true },
      }),
    ]);
    if (!autoResolvedRow.resolvedAt) throw new Error("scanner 未记录 resolvedAt");
    const legacyResolvedAt = new Date(autoResolutionAudit.createdAt.getTime() - 1);
    await prisma.resourceConflict.update({
      where: { id: legacyConflict.id },
      data: {
        // 模拟旧 scanner：当前周期唯一 CRON audit 晚于 resolvedAt，且残留 ignore actor。
        resolvedAt: legacyResolvedAt,
        // 旧 scanner 未清理 ignore actor；不可依赖该可空外键判定来源。
        resolvedByAccountId: legacyFixture.resourceManager.account.id,
      },
    });
    expect(autoResolutionAudit.createdAt.getTime()).toBeGreaterThan(
      legacyResolvedAt.getTime(),
    );
    const movedAwaySegment = movedAway.segments[0];
    if (!movedAwaySegment) throw new Error("未返回移动后的 Segment");
    const movedBack = await movePlannedSegments(actor(legacyFixture.member), {
      moves: [
        {
          segmentId: movable.segment.id,
          expectedUpdatedAt: movedAwaySegment.updatedAt,
          startAt: atHour(9.25),
          endAt: atHour(10.25),
        },
      ],
      reason: "恢复相同 fingerprint",
    });
    expect(movedBack.affectedSegmentIds).toEqual([movable.segment.id]);

    const legacyReopenResults = await runBehindPersonLockBarrier(
      legacyFixture.member.person.id,
      [
        () =>
          scanConflictsForPerson({
            personId: legacyFixture.member.person.id,
            startAt: atHour(9),
            endAt: atHour(12),
          }),
        () =>
          scanConflictsForPerson({
            personId: legacyFixture.member.person.id,
            startAt: atHour(9),
            endAt: atHour(12),
          }),
      ],
    );
    expect(
      legacyReopenResults.reduce((sum, result) => sum + result.reopenedCount, 0),
    ).toBe(0);
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: legacyConflict.id },
        select: { status: true, resolvedByAccountId: true },
      }),
    ).toEqual({ status: "OPEN", resolvedByAccountId: null });
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: legacyConflict.id,
          action: "pm.conflict.scan",
        },
      }),
    ).toBe(2);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: legacyConflict.id,
          action: "pm.conflict.resolve",
          source: "CRON",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:opened:${legacyConflict.fingerprint}` },
          type: "resource_conflict_opened",
        },
      }),
    ).toBe(2);

    const manualFixture = await createActivatedFixture({
      title: "P5 Manual Resolution Provenance",
    });
    await createWorkSegment(actor(manualFixture.member), {
      ...plannedInput(manualFixture.member.person.id, 13, 14, 70),
      taskId: manualFixture.taskId,
      nodeId: manualFixture.activeNodeId,
    });
    await createWorkSegment(actor(manualFixture.member), {
      ...plannedInput(manualFixture.member.person.id, 13.25, 14.25, 60),
      taskId: manualFixture.taskId,
      nodeId: manualFixture.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: manualFixture.member.person.id,
      startAt: atHour(13),
      endAt: atHour(15),
    });
    const manualConflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: manualFixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
      },
    });
    await resolveConflict(actor(manualFixture.resourceManager), {
      conflictId: manualConflict.id,
      resolutionNote: "明确人工终态",
      actorName: "客户端伪造操作人",
    });
    const manualResolvedPayload = await expectProjectManagementOutbox(
      `pm:conflict:resolved:${manualConflict.id}:`,
      "resource_conflict_resolved",
      true,
    );
    expect(manualResolvedPayload.actorName).toBe(
      manualFixture.resourceManager.person.displayName,
    );
    const manualResolvedInApp =
      await prisma.inAppNotification.findFirstOrThrow({
        where: {
          eventKey: {
            startsWith: `pm:conflict:resolved:${manualConflict.id}:`,
          },
        },
        select: { payload: true },
      });
    expect(
      (manualResolvedInApp.payload as Record<string, unknown>).actorName,
    ).toBe(manualFixture.resourceManager.person.displayName);
    await resolveConflict(actor(manualFixture.resourceManager), {
      conflictId: manualConflict.id,
      resolutionNote: "明确人工终态",
      actorName: "再次尝试伪造操作人",
    });
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: {
            startsWith: `pm:conflict:resolved:${manualConflict.id}:`,
          },
          type: "resource_conflict_resolved",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: manualConflict.id,
          action: "pm.conflict.resolve",
        },
      }),
    ).toBe(1);
    const manualRescan = await scanConflictsForPerson({
      personId: manualFixture.member.person.id,
      startAt: atHour(13),
      endAt: atHour(15),
    });
    expect(manualRescan.reopenedCount).toBe(0);
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: manualConflict.id },
        select: { status: true, resolvedByAccountId: true, resolutionNote: true },
      }),
    ).toEqual({
      status: "RESOLVED",
      resolvedByAccountId: manualFixture.resourceManager.account.id,
      resolutionNote: "明确人工终态",
    });
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:opened:${manualConflict.fingerprint}` },
          type: "resource_conflict_opened",
        },
      }),
    ).toBe(1);
  });

  test("Old, ambiguous and missing current-cycle audits conservatively keep RESOLVED terminal", async () => {
    const cases = [
      { kind: "old-audit", startHour: 9 },
      { kind: "same-cycle-ambiguity", startHour: 13 },
      { kind: "missing-current-audit", startHour: 17 },
    ] as const;
    for (const provenanceCase of cases) {
      const cycle = await createOpenAllocationConflict({
        title: `P5 ${provenanceCase.kind}`,
        startHour: provenanceCase.startHour,
      });
      const resolvedAt = new Date(
        `2026-07-30T${String(provenanceCase.startHour).padStart(2, "0")}:30:00.000Z`,
      );
      await prisma.resourceConflict.update({
        where: { id: cycle.conflict.id },
        data: {
          status: "RESOLVED",
          resolvedAt,
          resolvedByAccountId: null,
          resolutionNote: `保守来源 ${provenanceCase.kind}`,
        },
      });
      if (provenanceCase.kind === "old-audit") {
        await prisma.domainAuditEvent.create({
          data: {
            action: "pm.conflict.resolve",
            entityType: "ResourceConflict",
            entityId: cycle.conflict.id,
            reason: "早于当前 resolvedAt 的旧 CRON audit",
            source: "CRON",
            createdAt: new Date(resolvedAt.getTime() - 1),
          },
        });
      }
      if (provenanceCase.kind === "same-cycle-ambiguity") {
        await prisma.domainAuditEvent.createMany({
          data: [
            {
              action: "pm.conflict.resolve",
              entityType: "ResourceConflict",
              entityId: cycle.conflict.id,
              reason: "同周期 CRON 来源",
              source: "CRON",
              createdAt: new Date(resolvedAt.getTime() + 1),
            },
            {
              action: "pm.conflict.apply_suggestion",
              entityType: "ResourceConflict",
              entityId: cycle.conflict.id,
              reason: "同周期人工来源造成歧义",
              source: "WEB",
              actorAccountId: cycle.fixture.resourceManager.account.id,
              actorPersonId: cycle.fixture.resourceManager.person.id,
              createdAt: new Date(resolvedAt.getTime() + 2),
            },
          ],
        });
      }

      const rescan = await scanConflictsForPerson(cycle.range);
      expect(rescan.reopenedCount).toBe(0);
      expect(
        await prisma.resourceConflict.findUniqueOrThrow({
          where: { id: cycle.conflict.id },
          select: { status: true, resolutionNote: true },
        }),
      ).toEqual({
        status: "RESOLVED",
        resolutionNote: `保守来源 ${provenanceCase.kind}`,
      });
      expect(
        await prisma.domainAuditEvent.count({
          where: {
            entityType: "ResourceConflict",
            entityId: cycle.conflict.id,
            action: "pm.conflict.scan",
          },
        }),
      ).toBe(1);
      expect(
        await prisma.notificationOutbox.count({
          where: {
            eventKey: {
              startsWith: `pm:conflict:opened:${cycle.conflict.fingerprint}`,
            },
            type: "resource_conflict_opened",
          },
        }),
      ).toBe(1);
    }
  });

  test("A genuine apply-suggestion resolution remains terminal when its fingerprint returns", async () => {
    const cycle = await createOpenAllocationConflict({
      title: "P5 Apply Resolution Provenance",
      startHour: 9,
    });
    const preview = await previewConflictSuggestion(
      actor(cycle.fixture.resourceManager),
      { conflictId: cycle.conflict.id },
    );
    const proposal = preview.suggestions[0];
    if (!proposal) throw new Error("缺少用于 provenance 回归的处理建议");
    const originalById = new Map(
      [cycle.first.segment, cycle.second.segment].map((segment) => [
        segment.id,
        { startAt: segment.startAt, endAt: segment.endAt },
      ]),
    );
    const applied = await applyConflictSuggestion(
      actor(cycle.fixture.resourceManager),
      {
        conflictId: cycle.conflict.id,
        confirmApply: true,
        proposal,
      },
    );
    const appliedPayload = await expectProjectManagementOutbox(
      `pm:conflict:resolved:${cycle.conflict.id}:`,
      "resource_conflict_resolved",
      true,
    );
    expect(appliedPayload.actorName).toBe(
      cycle.fixture.resourceManager.person.displayName,
    );
    await movePlannedSegments(actor(cycle.fixture.member), {
      moves: applied.movedSegments.segments.map((segment) => {
        const original = originalById.get(segment.id);
        if (!original) throw new Error("建议移动了冲突范围外 Segment");
        return {
          segmentId: segment.id,
          expectedUpdatedAt: segment.updatedAt,
          startAt: original.startAt,
          endAt: original.endAt,
        };
      }),
      reason: "恢复 apply 前 fingerprint",
    });
    const rescan = await scanConflictsForPerson(cycle.range);
    expect(rescan.reopenedCount).toBe(0);
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: cycle.conflict.id },
        select: { status: true, resolvedByAccountId: true },
      }),
    ).toEqual({
      status: "RESOLVED",
      resolvedByAccountId: cycle.fixture.resourceManager.account.id,
    });
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: cycle.conflict.id,
          action: "pm.conflict.apply_suggestion",
          source: "WEB",
          actorAccountId: cycle.fixture.resourceManager.account.id,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:opened:${cycle.conflict.fingerprint}` },
          type: "resource_conflict_opened",
        },
      }),
    ).toBe(1);
  });

  test("Applying a suggestion rescans in-transaction and opens a newly created conflict exactly once", async () => {
    const fixture = await createActivatedFixture({
      title: "P5 Apply Creates New Conflict",
    });
    const first = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
      priority: "HIGH",
    });
    const moved = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
      priority: "LOW",
    });
    const future = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10.5, 11.5, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
      priority: "MEDIUM",
    });
    const original = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
        segments: { some: { segmentId: first.segment.id } },
      },
    });
    const preview = await previewConflictSuggestion(
      actor(fixture.resourceManager),
      { conflictId: original.id },
    );
    const proposal = preview.suggestions[0];
    if (!proposal) throw new Error("缺少冲突处理建议");

    const applied = await applyConflictSuggestion(
      actor(fixture.resourceManager),
      { conflictId: original.id, confirmApply: true, proposal },
    );
    expect(applied.status).toBe("RESOLVED");
    const newConflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        id: { not: original.id },
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
        status: "OPEN",
        AND: [
          { segments: { some: { segmentId: moved.segment.id } } },
          { segments: { some: { segmentId: future.segment.id } } },
        ],
      },
    });
    expect(newConflict.startAt.toISOString()).toBe(atHour(10.5).toISOString());
    expect(newConflict.endAt.toISOString()).toBe(atHour(11).toISOString());
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: original.id,
          action: "pm.conflict.apply_suggestion",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:resolved:${original.id}:` },
          type: "resource_conflict_resolved",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:opened:${newConflict.fingerprint}` },
          type: "resource_conflict_opened",
        },
      }),
    ).toBe(1);
  });

  test("Concurrent scans after automatic mutation rescan preserve one history/outbox set", async () => {
    const fixture = await createActivatedFixture();
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });

    const scans = await runBehindPersonLockBarrier(fixture.member.person.id, [
      () =>
        scanConflictsForPerson({
          personId: fixture.member.person.id,
          startAt: atHour(9),
          endAt: atHour(11),
        }),
      () =>
        scanConflictsForPerson({
          personId: fixture.member.person.id,
          startAt: atHour(9),
          endAt: atHour(11),
        }),
    ]);
    expect(scans.reduce((sum, result) => sum + result.createdCount, 0)).toBe(0);
    expect(scans.reduce((sum, result) => sum + result.unchangedCount, 0)).toBe(2);
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
      },
    });
    expect(
      await prisma.resourceConflict.count({ where: { fingerprint: conflict.fingerprint } }),
    ).toBe(1);
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: conflict.id,
          action: "pm.conflict.scan",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:opened:${conflict.fingerprint}` },
          type: "resource_conflict_opened",
        },
      }),
    ).toBe(1);
  });

  test("Segment mutation and scanner share the person lock and resolve once", async () => {
    const fixture = await createActivatedFixture({
      title: "P5 Mutation Scanner Race",
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const movable = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
      },
    });
    const results = await runBehindPersonLockBarrier(
      fixture.member.person.id,
      [
        async () => {
          await movePlannedSegments(actor(fixture.member), {
            moves: [
              {
                segmentId: movable.segment.id,
                expectedUpdatedAt: movable.segment.updatedAt,
                startAt: atHour(11),
                endAt: atHour(12),
              },
            ],
            reason: "mutation/scanner 竞争移动",
          });
          return "mutation";
        },
        async () => {
          await scanConflictsForPerson({
            personId: fixture.member.person.id,
            startAt: atHour(9),
            endAt: atHour(12),
          });
          return "scanner";
        },
      ],
    );
    expect(results.sort()).toEqual(["mutation", "scanner"]);
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: conflict.id },
        select: { status: true },
      }),
    ).toEqual({ status: "RESOLVED" });
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: conflict.id,
          action: "pm.conflict.resolve",
          source: "CRON",
        },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:resolved:${conflict.id}:` },
          type: "resource_conflict_resolved",
        },
      }),
    ).toBe(1);
  });

  test("Suggestion apply and competing mutation serialize with one winner and no duplicate side effects", async () => {
    const cycle = await createOpenAllocationConflict({
      title: "P5 Apply Mutation Race",
      startHour: 9,
    });
    const preview = await previewConflictSuggestion(
      actor(cycle.fixture.resourceManager),
      { conflictId: cycle.conflict.id },
    );
    const proposal = preview.suggestions[0];
    if (!proposal) throw new Error("缺少并发 apply 建议");
    const outcomes = await runBehindPersonLockBarrier(
      cycle.fixture.member.person.id,
      [
        async () => {
          try {
            await applyConflictSuggestion(actor(cycle.fixture.resourceManager), {
              conflictId: cycle.conflict.id,
              confirmApply: true,
              proposal,
            });
            return "apply:ok";
          } catch (error) {
            return `apply:${toProjectManagementServiceError(error).code}`;
          }
        },
        async () => {
          try {
            await movePlannedSegments(actor(cycle.fixture.member), {
              moves: [
                {
                  segmentId: cycle.second.segment.id,
                  expectedUpdatedAt: cycle.second.segment.updatedAt,
                  startAt: atHour(12),
                  endAt: atHour(13),
                },
              ],
              reason: "与 apply 竞争的人工移动",
            });
            return "mutation:ok";
          } catch (error) {
            return `mutation:${toProjectManagementServiceError(error).code}`;
          }
        },
      ],
    );
    expect(outcomes.filter((outcome) => outcome.endsWith(":ok"))).toHaveLength(1);
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^apply:(ok|STATE_CONFLICT)$/),
        expect.stringMatching(/^mutation:(ok|STALE_SEGMENT)$/),
      ]),
    );
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: cycle.conflict.id },
        select: { status: true },
      }),
    ).toEqual({ status: "RESOLVED" });
    expect(
      await prisma.domainAuditEvent.count({
        where: {
          entityType: "ResourceConflict",
          entityId: cycle.conflict.id,
          action: { in: ["pm.conflict.resolve", "pm.conflict.apply_suggestion"] },
        },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:resolved:${cycle.conflict.id}:` },
          type: "resource_conflict_resolved",
        },
      }),
    ).toBe(1);
  });

  test("Scanner and manual resolution races choose the real person/conflict lock-chain winner exactly once", async () => {
    for (const direction of ["scanner-first", "manual-first"] as const) {
      const fixture = await createActivatedFixture({ title: direction });
      await createWorkSegment(actor(fixture.member), {
        ...plannedInput(fixture.member.person.id, 9, 10, 70),
        taskId: fixture.taskId,
        nodeId: fixture.activeNodeId,
      });
      const movable = await createWorkSegment(actor(fixture.member), {
        ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
        taskId: fixture.taskId,
        nodeId: fixture.activeNodeId,
      });
      await scanConflictsForPerson({
        personId: fixture.member.person.id,
        startAt: atHour(9),
        endAt: atHour(11),
      });
      const conflict = await prisma.resourceConflict.findFirstOrThrow({
        where: {
          personId: fixture.member.person.id,
          kind: "ALLOCATION_OVER_LIMIT",
        },
      });
      // This race targets scanner/manual conflict status guards. A raw fixture
      // update intentionally leaves the Conflict stale; real Segment services
      // now rescan in the mutation transaction and are covered separately.
      await prisma.workSegment.update({
        where: { id: movable.segment.id },
        data: { startAt: atHour(11), endAt: atHour(12) },
      });
      const scan = () =>
        scanConflictsForPerson({
          personId: fixture.member.person.id,
          startAt: atHour(9),
          endAt: atHour(12),
        });
      const manualResolve = () =>
        resolveConflict(actor(fixture.resourceManager), {
          conflictId: conflict.id,
          resolutionNote: `并发人工解决 ${direction}`,
        });

      const outcomes = await runConflictRowLockChain(
        conflict.id,
        direction === "scanner-first" ? scan : manualResolve,
        direction === "scanner-first" ? manualResolve : scan,
      );
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      const scanOutcome = outcomes[direction === "scanner-first" ? 0 : 1];
      expect(scanOutcome).toMatchObject({
        status: "fulfilled",
        value: {
          resolvedCount: direction === "scanner-first" ? 1 : 0,
        },
      });
      const manualOutcome = outcomes[direction === "scanner-first" ? 1 : 0];
      expect(manualOutcome).toMatchObject({
        status: "fulfilled",
        value: { conflictId: conflict.id, status: "RESOLVED" },
      });

      const persisted = await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: conflict.id },
        select: { status: true, resolvedByAccountId: true, resolutionNote: true },
      });
      expect(persisted).toEqual({
        status: "RESOLVED",
        resolvedByAccountId:
          direction === "scanner-first"
            ? null
            : fixture.resourceManager.account.id,
        resolutionNote:
          direction === "scanner-first"
            ? "扫描确认冲突已解除"
            : `并发人工解决 ${direction}`,
      });
      expect(
        await prisma.domainAuditEvent.count({
          where: {
            entityType: "ResourceConflict",
            entityId: conflict.id,
            action: "pm.conflict.scan",
          },
        }),
      ).toBe(1);
      const resolutionAudits = await prisma.domainAuditEvent.findMany({
        where: {
          entityType: "ResourceConflict",
          entityId: conflict.id,
          action: "pm.conflict.resolve",
        },
        select: { source: true, actorAccountId: true, actorPersonId: true },
      });
      expect(resolutionAudits).toEqual([
        direction === "scanner-first"
          ? { source: "CRON", actorAccountId: null, actorPersonId: null }
          : {
              source: "WEB",
              actorAccountId: fixture.resourceManager.account.id,
              actorPersonId: fixture.resourceManager.person.id,
            },
      ]);
      expect(
        await prisma.notificationOutbox.count({
          where: {
            eventKey: { startsWith: `pm:conflict:resolved:${conflict.id}:` },
            type: "resource_conflict_resolved",
          },
        }),
      ).toBe(1);
      const resolvedOutbox = await prisma.notificationOutbox.findFirstOrThrow({
        where: {
          eventKey: { startsWith: `pm:conflict:resolved:${conflict.id}:` },
          type: "resource_conflict_resolved",
        },
        select: { payload: true, botKind: true },
      });
      expect(resolvedOutbox.botKind).toBe("notification");
      expect(JSON.parse(resolvedOutbox.payload)).toMatchObject({
        purpose: "notification",
        actorName:
          direction === "scanner-first"
            ? "系统"
            : fixture.resourceManager.person.displayName,
      });
      expect(
        await prisma.notificationOutbox.count({
          where: {
            eventKey: { startsWith: `pm:conflict:opened:${conflict.fingerprint}` },
            type: "resource_conflict_opened",
          },
        }),
      ).toBe(1);
    }
  });

  test("Manual handling requires system administrator when conflict includes no-task segments", async () => {
    const fixture = await createActivatedFixture();
    const systemAdmin = await createAccountPerson("P5 No Task Conflict System Admin");
    await grantRole(systemAdmin.account.id, "SYSTEM_ADMINISTRATOR");
    await createWorkSegment(actor(fixture.resourceManager), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
    });

    await expectServiceError(
      resolveConflict(actor(fixture.resourceManager), {
        conflictId: conflict.id,
        resolutionNote: "范围管理员不能处理无 Task 混合冲突",
      }),
      "STATE_CONFLICT",
    );

    const systemAdminDetail = await getResourceConflict({
      actor: actor(systemAdmin, [
        { role: "SYSTEM_ADMINISTRATOR", team: "", techGroup: "" },
      ]),
      input: { conflictId: conflict.id },
    });
    expect(systemAdminDetail.capabilities).toEqual({
      canAcknowledge: true,
      canResolve: true,
      canIgnore: true,
      canPreviewSuggestion: true,
      canApplySuggestion: true,
    });
    const preview = await previewConflictSuggestion(actor(systemAdmin), {
      conflictId: conflict.id,
    });
    expect(preview.suggestions[0]?.moves.length).toBeGreaterThan(0);
    const resolved = await resolveConflict(actor(systemAdmin), {
      conflictId: conflict.id,
      resolutionNote: "系统管理员处理无 Task Segment 冲突",
    });
    expect(resolved.status).toBe("RESOLVED");
  });

  test("Manual conflict handling enforces permissions and suggestion apply requires explicit versioned confirmation", async () => {
    const fixture = await createActivatedFixture();
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 80),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 50),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 20),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      include: { segments: { include: { segment: true } } },
    });

    await expectServiceError(
      resolveConflict(actor(fixture.outsider), {
        conflictId: conflict.id,
        resolutionNote: "越权解决",
      }),
      "NOT_FOUND",
    );
    const acknowledged = await acknowledgeConflict(actor(fixture.member), {
      conflictId: conflict.id,
      note: "我已知晓",
    });
    expect(acknowledged.status).toBe("ACKNOWLEDGED");

    const beforePreviewChangeCount = await prisma.workSegmentChange.count();
    const preview = await previewConflictSuggestion(actor(fixture.resourceManager), {
      conflictId: conflict.id,
    });
    const proposal = preview.suggestions[0];
    if (!proposal) throw new Error("缺少冲突处理建议");
    expect(conflict.segments).toHaveLength(3);
    expect(proposal.moves).toHaveLength(2);
    expect(await prisma.workSegmentChange.count()).toBe(beforePreviewChangeCount);

    await expectServiceError(
      applyConflictSuggestion(actor(fixture.resourceManager), {
        conflictId: conflict.id,
        confirmApply: false,
        proposal,
      }),
      "VALIDATION_ERROR",
    );
    const movesInServiceOrder = [...proposal.moves].sort((left, right) =>
      left.segmentId.localeCompare(right.segmentId),
    );
    const staleMove = movesInServiceOrder.at(-1);
    if (!staleMove) throw new Error("缺少用于 stale apply 的建议移动");
    const staleSegment = conflict.segments.find(
      (entry) => entry.segment.id === staleMove.segmentId,
    )?.segment;
    if (!staleSegment) throw new Error("建议 Segment 不属于冲突");
    await updateWorkSegment(actor(fixture.member), {
      segmentId: staleSegment.id,
      expectedUpdatedAt: staleSegment.updatedAt,
      content: `${staleSegment.content}（建议预览后更新）`,
      reason: "制造 stale suggestion",
    });
    const conflictSegmentIds = conflict.segments
      .map((entry) => entry.segment.id)
      .sort();
    const segmentsBeforeStaleApply = await prisma.workSegment.findMany({
      where: { id: { in: conflictSegmentIds } },
      select: { id: true, startAt: true, endAt: true, status: true, updatedAt: true },
      orderBy: { id: "asc" },
    });
    const changesBeforeStaleApply = await prisma.workSegmentChange.count({
      where: { segmentId: { in: conflictSegmentIds } },
    });
    const segmentAuditsBeforeStaleApply = await prisma.domainAuditEvent.count({
      where: { entityType: "WorkSegment", entityId: { in: conflictSegmentIds } },
    });
    const conflictAuditsBeforeStaleApply = await prisma.domainAuditEvent.count({
      where: { entityType: "ResourceConflict", entityId: conflict.id },
    });
    const conflictBeforeStaleApply = await prisma.resourceConflict.findUniqueOrThrow({
      where: { id: conflict.id },
      select: {
        status: true,
        acknowledgedAt: true,
        resolvedAt: true,
        resolvedByAccountId: true,
        resolutionNote: true,
        updatedAt: true,
      },
    });
    const outboxBeforeStaleApply = await prisma.notificationOutbox.count({
      where: { channel: "project-management" },
    });
    await expectServiceError(
      applyConflictSuggestion(actor(fixture.resourceManager), {
        conflictId: conflict.id,
        confirmApply: true,
        proposal,
      }),
      "STALE_SEGMENT",
    );
    expect(
      await prisma.workSegment.findMany({
        where: { id: { in: conflictSegmentIds } },
        select: { id: true, startAt: true, endAt: true, status: true, updatedAt: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(segmentsBeforeStaleApply);
    expect(
      await prisma.workSegmentChange.count({
        where: { segmentId: { in: conflictSegmentIds } },
      }),
    ).toBe(changesBeforeStaleApply);
    expect(
      await prisma.domainAuditEvent.count({
        where: { entityType: "WorkSegment", entityId: { in: conflictSegmentIds } },
      }),
    ).toBe(segmentAuditsBeforeStaleApply);
    expect(
      await prisma.domainAuditEvent.count({
        where: { entityType: "ResourceConflict", entityId: conflict.id },
      }),
    ).toBe(conflictAuditsBeforeStaleApply);
    expect(
      await prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    ).toBe(outboxBeforeStaleApply);
    expect(
      await prisma.resourceConflict.findUniqueOrThrow({
        where: { id: conflict.id },
        select: {
          status: true,
          acknowledgedAt: true,
          resolvedAt: true,
          resolvedByAccountId: true,
          resolutionNote: true,
          updatedAt: true,
        },
      }),
    ).toEqual(conflictBeforeStaleApply);

    const refreshedPreview = await previewConflictSuggestion(
      actor(fixture.resourceManager),
      { conflictId: conflict.id },
    );
    const applied = await applyConflictSuggestion(actor(fixture.resourceManager), {
      conflictId: conflict.id,
      confirmApply: true,
      proposal: refreshedPreview.suggestions[0],
    });
    expect(applied.status).toBe("RESOLVED");
    expect(applied.movedSegments.affectedSegmentIds.length).toBeGreaterThan(0);
  });
});

async function createOpenAllocationConflict(options: {
  title: string;
  startHour: number;
}) {
  const fixture = await createActivatedFixture({ title: options.title });
  const first = await createWorkSegment(actor(fixture.member), {
    ...plannedInput(
      fixture.member.person.id,
      options.startHour,
      options.startHour + 1,
      70,
    ),
    taskId: fixture.taskId,
    nodeId: fixture.activeNodeId,
  });
  const second = await createWorkSegment(actor(fixture.member), {
    ...plannedInput(
      fixture.member.person.id,
      options.startHour + 0.25,
      options.startHour + 1.25,
      60,
    ),
    taskId: fixture.taskId,
    nodeId: fixture.activeNodeId,
  });
  const range = {
    personId: fixture.member.person.id,
    startAt: atHour(options.startHour),
    endAt: atHour(options.startHour + 2),
  };
  await scanConflictsForPerson(range);
  const conflict = await prisma.resourceConflict.findFirstOrThrow({
    where: {
      personId: fixture.member.person.id,
      kind: "ALLOCATION_OVER_LIMIT",
      startAt: atHour(options.startHour + 0.25),
    },
  });
  return { fixture, first, second, range, conflict };
}

async function createActivatedFixture(options: {
  owner?: Awaited<ReturnType<typeof createAccountPerson>>;
  member?: Awaited<ReturnType<typeof createAccountPerson>>;
  title?: string;
  team?: string;
  techGroup?: string;
} = {}) {
  const admin = await createAccountPerson("P5 Conflict Team Admin");
  const owner = options.owner ?? (await createAccountPerson("P5 Conflict Owner"));
  const member = options.member ?? (await createAccountPerson("P5 Conflict Member"));
  const team = options.team ?? "英雄";
  const techGroup = options.techGroup ?? "电控";
  const reviewer = await createAccountPerson("P5 Conflict Reviewer");
  const viewer = await createAccountPerson("P5 Conflict Viewer");
  const outsider = await createAccountPerson("P5 Conflict Outsider");
  const resourceManager = await createAccountPerson("P5 Conflict Resource Manager");
  await grantRole(admin.account.id, "TEAM_ADMINISTRATOR", {
    team,
    techGroup,
  });
  await grantRole(resourceManager.account.id, "RESOURCE_MANAGER", {
    team,
    techGroup,
  });
  const draft = await createTaskDraft(actor(admin), {
    title: `${options.title ?? "P5 Conflict Task"} ${randomUUID()}`,
    description: "P5 Conflict 测试",
    team,
    techGroup,
    priority: "HIGH",
    tagIds: [],
    members: [
      { personId: owner.person.id, role: "OWNER" },
      { personId: member.person.id, role: "MEMBER" },
      { personId: reviewer.person.id, role: "REVIEWER" },
      { personId: viewer.person.id, role: "VIEWER" },
    ],
    plannedStartAt: new Date(Date.UTC(2026, 7, 1, 9, 0, 0)).toISOString(),
    milestones: [milestoneInput("阶段一", "完成阶段一", 1)],
    plannedStartAt: new Date(Date.UTC(2026, 6, 31, 10, 0, 0)).toISOString(),
    termination: terminationInput(4),
    idempotencyKey: `p5-conflict-task-${randomUUID()}`,
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
    viewer,
    outsider,
    resourceManager,
    taskId: draft.taskId,
    currentPlanVersionId: activated.currentPlanVersionId,
    activeNodeId: activeNode.nodeId,
  };
}

function plannedInput(
  personId: string,
  startHour: number,
  endHour: number,
  allocation: number | null,
) {
  return {
    personId,
    type: "PLANNED",
    startAt: atHour(startHour),
    endAt: atHour(endHour),
    content: `冲突计划 ${startHour}-${endHour}`,
    allocation,
    role: "DEVELOPER",
    priority: "MEDIUM",
    tagIds: [],
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
    plannedOutcomeCriteria: "所有 Milestone 完成并完成总结",
    plannedAt: new Date(
      Date.UTC(2026, 7, daysFromBase, 10, 0, 0),
    ).toISOString(),
    businessDescription: "结束确认",
  };
}

async function currentActiveMilestone(taskId: string) {
  return prisma.planVersionNode.findFirstOrThrow({
    where: {
      planVersion: { taskId, status: "CURRENT" },
      node: { type: "MILESTONE", status: "ACTIVE" },
    },
    select: { nodeId: true },
  });
}

async function createAccountPerson(displayName: string) {
  const openId = `ou_pm_p5_conflict_${randomUUID()}`;
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
  scope: { team: string; techGroup: string } = { team: "", techGroup: "" },
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team: scope.team,
      techGroup: scope.techGroup,
    },
  });
}

function actor(
  input: Awaited<ReturnType<typeof createAccountPerson>>,
  systemRoles: ProjectManagementActor["systemRoles"] = [],
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
  return new Date(Date.UTC(2026, 7, 11, fullHour, minutes, 0));
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: ReturnType<typeof toProjectManagementServiceError>["code"],
) {
  await expect(
    promise.catch((error) => toProjectManagementServiceError(error).code),
  ).resolves.toBe(code);
}

async function conflictWriteCounts(personId: string) {
  return {
    conflicts: await prisma.resourceConflict.count({ where: { personId } }),
    conflictAudits: await prisma.domainAuditEvent.count({
      where: { entityType: "ResourceConflict" },
    }),
    projectManagementOutbox: await prisma.notificationOutbox.count({
      where: { channel: "project-management" },
    }),
  };
}

async function conflictApplyWriteState(
  conflictId: string,
  segmentIds: string[],
) {
  const [conflict, segments, changes, sources, audits, notifications, outbox] =
    await Promise.all([
      prisma.resourceConflict.findUniqueOrThrow({
        where: { id: conflictId },
        select: {
          status: true,
          resolvedAt: true,
          resolvedByAccountId: true,
          resolutionNote: true,
          updatedAt: true,
        },
      }),
      prisma.workSegment.findMany({
        where: { id: { in: segmentIds } },
        select: {
          id: true,
          status: true,
          startAt: true,
          endAt: true,
          updatedAt: true,
          updatedByAccountId: true,
        },
        orderBy: { id: "asc" },
      }),
      prisma.workSegmentChange.count({
        where: { segmentId: { in: segmentIds } },
      }),
      prisma.workSegmentSource.count({
        where: {
          OR: [
            { plannedSegmentId: { in: segmentIds } },
            { actualSegmentId: { in: segmentIds } },
          ],
        },
      }),
      prisma.domainAuditEvent.count({
        where: {
          OR: [
            { entityType: "ResourceConflict", entityId: conflictId },
            { entityType: "WorkSegment", entityId: { in: segmentIds } },
          ],
        },
      }),
      prisma.inAppNotification.count(),
      prisma.notificationOutbox.count({
        where: { channel: "project-management" },
      }),
    ]);
  return {
    conflict,
    segments,
    changes,
    sources,
    audits,
    notifications,
    outbox,
  };
}

function conflictPersonLockKeys(personId: string) {
  const digest = createHash("sha256")
    .update(`pm:resource-conflict:person:${personId}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)] as const;
}

async function lockConflictPerson(client: Client, personId: string) {
  const [namespaceKey, personKey] = conflictPersonLockKeys(personId);
  await client.query("BEGIN");
  const pid = await databaseBackendPid(client);
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
    namespaceKey,
    personKey,
  ]);
  return pid;
}

async function lockConflictRow(client: Client, conflictId: string) {
  await client.query("BEGIN");
  const pid = await databaseBackendPid(client);
  await client.query(
    'SELECT "id" FROM "ResourceConflict" WHERE "id" = $1 FOR UPDATE',
    [conflictId],
  );
  return pid;
}

async function databaseBackendPid(client: Client) {
  const result = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = result.rows[0]?.pid;
  if (!pid) throw new Error("无法取得 PostgreSQL backend pid");
  return pid;
}

function fakeSignalObserver(input: {
  databaseName?: string;
  observerPid?: number;
  activities?: Array<{
    pid: number;
    databaseName: string | null;
    backendType: string;
  }>;
}) {
  const databaseName = input.databaseName ?? "management_system_test";
  const observerPid = input.observerPid ?? 7100;
  const client = {
    query: async (sql: string) => {
      if (sql.includes("current_database()")) {
        return { rows: [{ databaseName, observerPid }] };
      }
      if (sql.includes('FROM "pg_stat_activity"')) {
        return { rows: input.activities ?? [] };
      }
      throw new Error("fake signal observer 收到非预期 SQL");
    },
  };
  return client as unknown as Client;
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

async function waitForBackendToLeaveLockWait(
  observer: Client,
  lockerPid: number,
  blockedPid: number,
) {
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    const result = await observer.query<{ stillBlocked: boolean }>(
      `SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS "stillBlocked"`,
      [lockerPid, blockedPid],
    );
    if (result.rows[0]?.stillBlocked === false) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`backend ${blockedPid} 未确认处理取消信号`);
}

async function runBehindPersonLockBarrier<T>(
  personId: string,
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
  let result: T[] | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    locker = await connectDatabaseClient("person-barrier-locker");
    observer = await connectDatabaseClient("person-barrier-observer");
    transactionMayBeOpen = true;
    const lockerPid = await lockConflictPerson(locker, personId);
    const started = startBarrierOperations(operations);
    pending = started.pending;
    pendingSettlement = started.settlement;
    const blockedPids = await waitForDirectBlockers(observer, lockerPid, 2);
    pendingBackendPids = blockedPids;
    if (new Set(blockedPids).size < 2) {
      throw new Error("两个扫描事务未使用独立 PostgreSQL backend");
    }
    await locker.query("COMMIT");
    released = true;
    result = await Promise.all(pending);
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
  if (!result) throw new Error("Person lock barrier 未返回并发结果");
  return result;
}

async function runConflictRowLockChain(
  conflictId: string,
  firstOperation: () => Promise<unknown>,
  secondOperation: () => Promise<unknown>,
) {
  let locker: Client | undefined;
  let observer: Client | undefined;
  let transactionMayBeOpen = false;
  let released = false;
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  const settlements: Promise<PromiseSettledResult<unknown>[]>[] = [];
  const pendingBackendPids: number[] = [];
  let pendingHandled = false;
  let result: PromiseSettledResult<unknown>[] | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    locker = await connectDatabaseClient("conflict-chain-locker");
    observer = await connectDatabaseClient("conflict-chain-observer");
    transactionMayBeOpen = true;
    const lockerPid = await lockConflictRow(locker, conflictId);
    const firstStarted = startBarrierOperations([firstOperation]);
    first = firstStarted.pending[0];
    settlements.push(firstStarted.settlement);
    if (!first) throw new Error("首个冲突操作 promise 未创建");
    const [firstPid] = await waitForDirectBlockers(observer, lockerPid, 1);
    if (!firstPid) throw new Error("首个冲突事务未到达 conflict row lock");
    pendingBackendPids.push(firstPid);
    const secondStarted = startBarrierOperations([secondOperation]);
    second = secondStarted.pending[0];
    settlements.push(secondStarted.settlement);
    if (!second) throw new Error("第二个冲突操作 promise 未创建");
    const [secondPid] = await waitForDirectBlockers(observer, firstPid, 1);
    if (!secondPid || secondPid === firstPid) {
      throw new Error("第二个冲突事务未在独立 backend 等待人员锁");
    }
    pendingBackendPids.push(secondPid);
    await locker.query("COMMIT");
    released = true;
    result = (await Promise.all(settlements)).flat();
    pendingHandled = true;
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }
  const cleanupErrors = await cleanupBarrierResources({
    locker,
    observer,
    rollbackRequired: Boolean(locker && transactionMayBeOpen && !released),
    pendingSettlement:
      settlements.length > 0
        ? Promise.all(settlements).then((outcomes) => outcomes.flat())
        : undefined,
    pendingBackendPids,
    pendingHandled,
    primaryError,
  });
  throwBarrierErrors(hasPrimaryError, primaryError, cleanupErrors);
  if (!result) throw new Error("Conflict row lock chain 未返回并发结果");
  return result;
}

async function expectServiceAcceptance(
  promise: Promise<unknown>,
  accepted: boolean,
) {
  if (accepted) {
    await expect(promise).resolves.toBeTruthy();
    return;
  }
  await expectServiceError(promise, "STATE_CONFLICT");
}

async function setConflictStatus(
  conflictId: string,
  status: "OPEN" | "ACKNOWLEDGED" | "IGNORED" | "RESOLVED",
) {
  await prisma.resourceConflict.update({
    where: { id: conflictId },
    data: { status },
  });
}

async function expectProjectManagementOutbox(
  eventKeyPrefix: string,
  type: string,
  prefix = false,
) {
  const row = prefix
    ? await prisma.notificationOutbox.findFirstOrThrow({
        where: { eventKey: { startsWith: eventKeyPrefix } },
      })
    : await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey: eventKeyPrefix },
      });
  expect(row.channel).toBe("project-management");
  expect(row.type).toBe(type);
  expect(row.botKind).toBe("notification");
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  expect(payload.purpose).toBe("notification");
  return payload;
}
