// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { getContentDrivenTimeCanvasData, getTimeCanvasData, loadBoundedAdaptiveLeaves } from "../lib/project-management/queries/time-canvas-queries";

import {
  RANGE_END,
  RANGE_START,
  actor,
  atHour,
  canvasInput,
  createAccountPerson,
  createAnchorTaskBatch,
  createSegment,
  createSegmentsInChunks,
  createTask,
  expectErrorCode,
  fullSegmentIds,
  grantGlobalProjectAdministrator,
  systemAdministratorRole,
} from "./helpers/project-management-canvas-security-fixtures";

test.describe("project management canvas security project-management-canvas-adaptive-loading", () => {
  test("time-object limit counts all globally visible Full records and rejects 5001", async () => {
      test.setTimeout(120_000);
      const owner = await createAccountPerson("5000 Full 上限 Owner");
      const target = await createAccountPerson("5000 Full 上限目标");
      const hiddenOwner = await createAccountPerson("5000 Full 隐藏 Owner");
      await grantGlobalProjectAdministrator(owner.account.id);
      const visibleTask = await createTask({
        ownerAccountId: owner.account.id,
        title: "5000 Full 可见 Task",
        team: "英雄",
        techGroup: "电控",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: target.person.id, role: "PARTICIPANT" },
        ],
      });
      const hiddenTask = await createTask({
        ownerAccountId: hiddenOwner.account.id,
        title: "5000 Full 隐藏 Task",
        team: "步兵",
        techGroup: "机械",
        members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
      });
      const startAt = atHour(9);
      const endAt = atHour(10);
      const rows = Array.from({ length: 4_975 }, (_, index) => ({
        id: randomUUID(),
        personId: target.person.id,
        type: "PLANNED" as const,
        status: "PLANNED" as const,
        startAt,
        endAt,
        content: `批量可见 ${index}`,
        priority: "LOW" as const,
        taskId: visibleTask.taskId,
        createdByAccountId: owner.account.id,
      }));
      await createSegmentsInChunks(rows);
      const hiddenRows = Array.from({ length: 25 }, (_, index) => ({
        id: randomUUID(),
        personId: target.person.id,
        type: "PLANNED" as const,
        status: "PLANNED" as const,
        startAt,
        endAt,
        content: `批量隐藏 ${index}`,
        priority: "LOW" as const,
        taskId: hiddenTask.taskId,
        createdByAccountId: hiddenOwner.account.id,
      }));
      await createSegmentsInChunks(hiddenRows);
      const input = canvasInput({
        scope: { kind: "TASK_SCOPED", taskId: visibleTask.taskId },
        groupBy: "PERSON",
        personIds: [target.person.id],
        includeBusyBlocks: false,
      });
      const atLimit = await getTimeCanvasData({ actor: actor(owner), input });
      expect(atLimit.segments).toHaveLength(5_000);
      expect(JSON.stringify(atLimit)).toContain(hiddenRows[0]!.id);
      expect(JSON.stringify(atLimit)).toContain("批量隐藏");
      await createSegment({
        accountId: owner.account.id,
        personId: target.person.id,
        taskId: visibleTask.taskId,
        startAt,
        endAt,
        content: "第 5001 条",
      });
      await expectErrorCode(
        getTimeCanvasData({ actor: actor(owner), input }),
        "QUERY_LIMIT_EXCEEDED",
      );
    });

  test("content-driven blocks split at Shanghai day boundaries and isolate a dense day failure", async () => {
      test.setTimeout(120_000);
      const owner = await createAccountPerson("内容驱动自动细分 Owner");
      const target = await createAccountPerson("内容驱动自动细分目标");
      await grantGlobalProjectAdministrator(owner.account.id);
      const firstDayStart = new Date("2020-08-10T09:00:00.000+08:00");
      const firstDayEnd = new Date("2020-08-10T10:00:00.000+08:00");
      const task = await createTask({
        ownerAccountId: owner.account.id,
        title: "内容驱动自动细分 Task",
        team: "英雄",
        techGroup: "电控",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: target.person.id, role: "PARTICIPANT" },
        ],
        plannedStartAt: firstDayStart,
      });
      await prisma.milestoneNode.update({
        where: { nodeId: task.milestoneNodeId },
        data: { expectedCompletedAt: firstDayEnd },
      });
      const rows = Array.from({ length: 5_001 }, (_, index) => ({
        id: randomUUID(),
        personId: target.person.id,
        type: "PLANNED" as const,
        status: "PLANNED" as const,
        startAt: firstDayStart,
        endAt: firstDayEnd,
        content: `内容驱动密集投入 ${index}`,
        priority: "LOW" as const,
        taskId: task.taskId,
        createdByAccountId: owner.account.id,
      }));
      await createSegmentsInChunks(rows);
      const normalSegment = await createSegment({
        accountId: owner.account.id,
        personId: target.person.id,
        taskId: task.taskId,
        startAt: new Date("2020-08-12T09:00:00.000+08:00"),
        endAt: new Date("2020-08-12T10:00:00.000+08:00"),
        content: "密集日期外仍可浏览",
      });
      try {
        const input = {
          scope: { kind: "TASK_SCOPED" as const, taskId: task.taskId },
          personIds: [],
          taskIds: [],
          types: [],
          statuses: [],
          groupBy: "PERSON" as const,
          includeTaskAnchors: true,
          includeActual: true,
          includeBusyBlocks: false,
        };
        const denseDay = await getContentDrivenTimeCanvasData({
          actor: actor(owner),
          input,
          load: { mode: "INITIAL" },
        });
        expect(denseDay.data.segments.some(
          (segment) => segment.kind === "SEGMENT" && segment.id === normalSegment.id,
        )).toBe(true);
        expect(denseDay.failedRanges).toEqual([
          {
            startMs: Date.parse("2020-08-10T00:00:00.000+08:00"),
            endMs: Date.parse("2020-08-11T00:00:00.000+08:00"),
            message: "单个上海自然日内的时间对象超过 5000 条，请缩小筛选范围",
          },
        ]);
        expect(denseDay.leafBlockCount).toBeLessThanOrEqual(16);

        const movedIds = rows.slice(2_500).map((row) => row.id);
        await prisma.workSegment.updateMany({
          where: { id: { in: movedIds } },
          data: {
            startAt: new Date("2020-08-11T09:00:00.000+08:00"),
            endAt: new Date("2020-08-11T10:00:00.000+08:00"),
          },
        });
        const split = await getContentDrivenTimeCanvasData({
          actor: actor(owner),
          input,
          load: { mode: "INITIAL" },
        });
        expect(split.data.segments).toHaveLength(5_002);
        expect(split.failedRanges).toEqual([]);
        expect(split.leafBlockCount).toBeGreaterThan(1);
        expect(split.leafBlockCount).toBeLessThanOrEqual(16);
        const replay = await getContentDrivenTimeCanvasData({
          actor: actor(owner),
          input,
          preferredCenterMs: split.resolvedCenterMs,
          load: {
            mode: "BLOCK",
            range: split.loadedRange,
            expectedRowPageKey: split.data.rowPageKey!,
          },
        });
        expect(replay.data.rowPageKey).toBe(split.data.rowPageKey);
      } finally {
        await prisma.workSegment.updateMany({
          where: { taskId: task.taskId },
          data: { status: "CANCELLED" },
        });
      }
    });

  test("content-driven subdivision stops before exceeding its query and leaf budgets", async () => {
      let queryCount = 0;
      await expectErrorCode(
        loadBoundedAdaptiveLeaves({
          ranges: [{
            startMs: Date.parse("2020-01-01T00:00:00.000+08:00"),
            endMs: Date.parse("2021-01-01T00:00:00.000+08:00"),
          }],
          loadRange: async () => {
            queryCount += 1;
            return new Array<null>(5_001).fill(null);
          },
        }),
        "QUERY_LIMIT_EXCEEDED",
      );
      expect(queryCount).toBeLessThanOrEqual(31);
    });

  test("content-driven Task uses createdAt for a nullable legacy Start", async () => {
      const owner = await createAccountPerson("空计划开始兼容 Owner");
      await grantGlobalProjectAdministrator(owner.account.id);
      const task = await createTask({
        ownerAccountId: owner.account.id,
        title: "空计划开始兼容 Task",
        team: "英雄",
        techGroup: "电控",
        members: [{ personId: owner.person.id, role: "OWNER" }],
        plannedStartAt: null,
      });
      const compatibilityStart = atHour(7);
      const taskCreatedAt = await prisma.task.update({
        where: { id: task.taskId },
        data: { createdAt: compatibilityStart },
        select: { createdAt: true },
      });
      const result = await getContentDrivenTimeCanvasData({
        actor: actor(owner),
        input: {
          scope: { kind: "TASK_SCOPED", taskId: task.taskId },
          personIds: [],
          taskIds: [],
          types: [],
          statuses: [],
          groupBy: "PERSON",
          includeTaskAnchors: true,
          includeActual: true,
          includeBusyBlocks: false,
        },
        load: { mode: "INITIAL" },
      });
      expect(result.data.anchors[0]).toMatchObject({
        id: task.taskId,
        createdAt: taskCreatedAt.createdAt.toISOString(),
        plannedStartAt: null,
      });
      expect(result.contentRange?.startMs).toBe(taskCreatedAt.createdAt.getTime());
    });

  test("active Planned expands content-driven range with Shanghai month padding", async () => {
      const owner = await createAccountPerson("Planned 范围 Owner");
      await grantGlobalProjectAdministrator(owner.account.id);
      const task = await createTask({
        ownerAccountId: owner.account.id,
        title: "Planned 范围 Task",
        team: "英雄",
        techGroup: "电控",
        members: [{ personId: owner.person.id, role: "OWNER" }],
        plannedStartAt: new Date("2026-08-01T09:00:00.000+08:00"),
      });
      const activeStart = new Date("2026-06-01T09:00:00.000+08:00");
      const activeEnd = new Date("2026-06-02T09:00:00.000+08:00");
      const [activeSegment] = await Promise.all([
        createSegment({
          accountId: owner.account.id,
          personId: owner.person.id,
          taskId: task.taskId,
          startAt: activeStart,
          endAt: activeEnd,
          content: "有效 Planned 范围边界",
        }),
        createSegment({
          accountId: owner.account.id,
          personId: owner.person.id,
          taskId: task.taskId,
          status: "CONFIRMED",
          startAt: new Date("2026-02-01T09:00:00.000+08:00"),
          endAt: new Date("2026-02-02T09:00:00.000+08:00"),
          content: "已确认 Planned 不扩展范围",
        }),
        createSegment({
          accountId: owner.account.id,
          personId: owner.person.id,
          taskId: task.taskId,
          status: "CANCELLED",
          startAt: new Date("2026-01-01T09:00:00.000+08:00"),
          endAt: new Date("2026-01-02T09:00:00.000+08:00"),
          content: "已取消 Planned 不扩展范围",
        }),
      ]);

      const beforeQuery = Date.now();
      const result = await getContentDrivenTimeCanvasData({
        actor: actor(owner),
        preferredCenterMs: Date.parse("2026-08-01T09:00:00.000+08:00"),
        input: {
          scope: { kind: "TASK_SCOPED", taskId: task.taskId },
          personIds: [],
          taskIds: [],
          types: [],
          statuses: [],
          groupBy: "PERSON",
          includeTaskAnchors: true,
          includeActual: true,
          includeBusyBlocks: false,
        },
        load: { mode: "INITIAL" },
      });
      const afterQuery = Date.now();

      expect(result.contentRange?.startMs).toBe(activeStart.getTime());
      expect(result.fullRange.startMs).toBe(
        Date.parse("2026-04-01T00:00:00.000+08:00"),
      );
      expect(result.fullRange.startMs).toBeLessThanOrEqual(beforeQuery);
      expect(result.fullRange.endMs).toBeGreaterThan(afterQuery);
      expect(Date.parse(result.data.range.startAt)).toBe(result.fullRange.startMs);

      const explicitResourceRange = await getTimeCanvasData({
        actor: actor(owner),
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [owner.person.id],
        }),
      });
      expect(explicitResourceRange.range).toEqual({
        startAt: RANGE_START,
        endAt: RANGE_END,
      });
      expect(fullSegmentIds(explicitResourceRange)).not.toContain(activeSegment.id);
    });

  test("content-driven initial range stays on historical content while Today remains navigable", async () => {
      const owner = await createAccountPerson("历史默认范围 Owner");
      await grantGlobalProjectAdministrator(owner.account.id);
      const historicalStart = new Date("2020-01-01T09:00:00.000+08:00");
      const historicalMilestone = new Date("2020-02-01T09:00:00.000+08:00");
      const task = await createTask({
        ownerAccountId: owner.account.id,
        title: "历史默认范围 Task",
        team: "英雄",
        techGroup: "电控",
        members: [{ personId: owner.person.id, role: "OWNER" }],
        plannedStartAt: historicalStart,
      });
      await prisma.milestoneNode.update({
        where: { nodeId: task.milestoneNodeId },
        data: { expectedCompletedAt: historicalMilestone },
      });

      const todayMarker = await prisma.globalTimeMarker.create({
        data: {
          name: `不抢占历史业务中心 ${randomUUID()}`,
          markedAt: new Date(),
        },
      });
      const extremeMarker = await prisma.globalTimeMarker.create({
        data: {
          name: `极远日期仍可定位 ${randomUUID()}`,
          markedAt: new Date("9999-12-31T15:59:00.000Z"),
        },
      });
      const beforeQuery = Date.now();
      try {
        const result = await getContentDrivenTimeCanvasData({
          actor: actor(owner),
          input: {
            scope: { kind: "TASK_SCOPED", taskId: task.taskId },
            personIds: [],
            taskIds: [],
            types: [],
            statuses: [],
            groupBy: "PERSON",
            includeTaskAnchors: true,
            includeActual: true,
            includeBusyBlocks: false,
          },
          load: { mode: "INITIAL" },
        });
        const logicalStart = Date.parse(result.data.range.startAt);
        const logicalEnd = Date.parse(result.data.range.endAt);

        expect(logicalStart).toBeLessThanOrEqual(historicalStart.getTime());
        expect(logicalEnd).toBeGreaterThan(historicalMilestone.getTime());
        expect(logicalEnd).toBeLessThan(beforeQuery);
        expect(result.fullRange.startMs).toBeLessThanOrEqual(historicalStart.getTime());
        expect(result.fullRange.endMs).toBeGreaterThan(beforeQuery);

        const extremeResult = await getContentDrivenTimeCanvasData({
          actor: actor(owner),
          input: {
            scope: { kind: "TASK_SCOPED", taskId: task.taskId },
            personIds: [],
            taskIds: [],
            types: [],
            statuses: [],
            groupBy: "PERSON",
            includeTaskAnchors: true,
            includeActual: true,
            includeBusyBlocks: false,
          },
          preferredCenterMs: extremeMarker.markedAt.getTime(),
          load: { mode: "INITIAL" },
        });
        expect(extremeResult.resolvedCenterMs).toBe(extremeMarker.markedAt.getTime());
        expect(extremeResult.data.globalMarkers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: extremeMarker.id }),
          ]),
        );
        expect(extremeResult.data.range.endAt).toBe(
          "9999-12-31T23:59:59.999Z",
        );
      } finally {
        await prisma.globalTimeMarker.updateMany({
          where: { id: { in: [todayMarker.id, extremeMarker.id] } },
          data: { deletedAt: new Date() },
        });
      }
    });

  test("time-object limit rejects 5001 Busy-only records without an unbounded response", async () => {
      test.setTimeout(120_000);
      const owner = await createAccountPerson("5001 Busy Owner");
      const target = await createAccountPerson("5001 Busy 目标");
      const hiddenOwner = await createAccountPerson("5001 Busy 隐藏 Owner");
      const visibleTask = await createTask({
        ownerAccountId: owner.account.id,
        title: "5001 Busy 画布 Task",
        team: "英雄",
        techGroup: "电控",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: target.person.id, role: "PARTICIPANT" },
        ],
      });
      const hiddenTask = await createTask({
        ownerAccountId: hiddenOwner.account.id,
        title: "5001 Busy 隐藏 Task",
        team: "步兵",
        techGroup: "机械",
        members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
      });
      await createSegmentsInChunks(
        Array.from({ length: 5_001 }, (_, index) => ({
          id: randomUUID(),
          personId: target.person.id,
          type: "PLANNED" as const,
          status: "PLANNED" as const,
          startAt: atHour(9),
          endAt: atHour(10),
          content: `Busy-only 隐藏 ${index}`,
          priority: "LOW" as const,
          taskId: hiddenTask.taskId,
          createdByAccountId: hiddenOwner.account.id,
        })),
      );
      await expectErrorCode(
        getTimeCanvasData({
          actor: actor(owner),
          input: canvasInput({
            scope: { kind: "TASK_SCOPED", taskId: visibleTask.taskId },
            groupBy: "PERSON",
            personIds: [target.person.id],
            includeBusyBlocks: true,
          }),
        }),
        "QUERY_LIMIT_EXCEEDED",
      );
    });

  test("time-object limit rejects 4999 Full plus 2 Busy as one 5001-object response", async () => {
      test.setTimeout(120_000);
      const owner = await createAccountPerson("4999 Full + 2 Busy Owner");
      const target = await createAccountPerson("4999 Full + 2 Busy 目标");
      const hiddenOwner = await createAccountPerson("4999 Full + 2 Busy 隐藏 Owner");
      const visibleTask = await createTask({
        ownerAccountId: owner.account.id,
        title: "4999 Full + 2 Busy 可见 Task",
        team: "英雄",
        techGroup: "电控",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: target.person.id, role: "PARTICIPANT" },
        ],
      });
      const hiddenTask = await createTask({
        ownerAccountId: hiddenOwner.account.id,
        title: "4999 Full + 2 Busy 隐藏 Task",
        team: "步兵",
        techGroup: "机械",
        members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
      });
      await createSegmentsInChunks([
        ...Array.from({ length: 4_999 }, (_, index) => ({
          id: randomUUID(),
          personId: target.person.id,
          type: "PLANNED" as const,
          status: "PLANNED" as const,
          startAt: atHour(9),
          endAt: atHour(10),
          content: `Full+Busy 可见 ${index}`,
          priority: "LOW" as const,
          taskId: visibleTask.taskId,
          createdByAccountId: owner.account.id,
        })),
        ...Array.from({ length: 2 }, (_, index) => ({
          id: randomUUID(),
          personId: target.person.id,
          type: "PLANNED" as const,
          status: "PLANNED" as const,
          startAt: atHour(9),
          endAt: atHour(10),
          content: `Full+Busy 隐藏 ${index}`,
          priority: "LOW" as const,
          taskId: hiddenTask.taskId,
          createdByAccountId: hiddenOwner.account.id,
        })),
      ]);
      await expectErrorCode(
        getTimeCanvasData({
          actor: actor(owner),
          input: canvasInput({
            scope: { kind: "TASK_SCOPED", taskId: visibleTask.taskId },
            groupBy: "PERSON",
            personIds: [target.person.id],
            includeBusyBlocks: true,
          }),
        }),
        "QUERY_LIMIT_EXCEEDED",
      );
    });

  test("anchor Task rows are unpaged while total current-plan Node budget stays bounded", async () => {
      test.setTimeout(180_000);
      const owner = await createAccountPerson("Anchor budget Owner");
      const target = await createAccountPerson("Anchor budget Target");
      await grantGlobalProjectAdministrator(owner.account.id);
      await createAnchorTaskBatch({
        ownerAccountId: owner.account.id,
        ownerPersonId: owner.person.id,
        targetPersonId: target.person.id,
        titlePrefix: "Anchor Task boundary",
        taskCount: 50,
        nodesPerTask: 1,
      });
      const taskBudgetInput = canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [target.person.id],
        includeTaskAnchors: true,
      });
      const exactTasks = await getTimeCanvasData({
        actor: actor(owner, [systemAdministratorRole()]),
        input: taskBudgetInput,
      });
      expect(exactTasks.anchors).toHaveLength(50);
      await createAnchorTaskBatch({
        ownerAccountId: owner.account.id,
        ownerPersonId: owner.person.id,
        targetPersonId: target.person.id,
        titlePrefix: "Anchor Task overflow",
        taskCount: 1,
        nodesPerTask: 1,
      });
      const unpagedTasks = await getTimeCanvasData({
        actor: actor(owner, [systemAdministratorRole()]),
        input: taskBudgetInput,
      });
      expect(unpagedTasks.anchors).toHaveLength(51);

      const nodeOwner = await createAccountPerson("Anchor node budget Owner");
      const nodeTarget = await createAccountPerson("Anchor node budget Target");
      await createAnchorTaskBatch({
        ownerAccountId: nodeOwner.account.id,
        ownerPersonId: nodeOwner.person.id,
        targetPersonId: nodeTarget.person.id,
        titlePrefix: "Anchor 200-node exact",
        taskCount: 25,
        nodesPerTask: 200,
      });
      const nodeBudgetInput = canvasInput({
        scope: { kind: "RESOURCE_PLANNER" },
        groupBy: "PERSON",
        personIds: [nodeTarget.person.id],
        includeTaskAnchors: true,
      });
      const exactNodes = await getTimeCanvasData({
        actor: actor(nodeOwner, [systemAdministratorRole()]),
        input: nodeBudgetInput,
      });
      expect(exactNodes.anchors).toHaveLength(25);
      expect(
        exactNodes.anchors.reduce((count, anchor) => count + anchor.nodes.length, 0),
      ).toBe(5_000);
      expect(exactNodes.anchors.every((anchor) => anchor.nodes.length === 200)).toBe(
        true,
      );
      await createAnchorTaskBatch({
        ownerAccountId: nodeOwner.account.id,
        ownerPersonId: nodeOwner.person.id,
        targetPersonId: nodeTarget.person.id,
        titlePrefix: "Anchor 200-node overflow",
        taskCount: 1,
        nodesPerTask: 200,
      });
      await expectErrorCode(
        getTimeCanvasData({
          actor: actor(nodeOwner, [systemAdministratorRole()]),
          input: nodeBudgetInput,
        }),
        "QUERY_LIMIT_EXCEEDED",
      );
    });

  test("empty canvases retain safe rows without fabricating time objects", async () => {
      const person = await createAccountPerson("空画布人员");
      const personal = await getTimeCanvasData({
        actor: actor(person),
        input: canvasInput({
          scope: { kind: "PERSONAL" },
          groupBy: "PERSON",
        }),
      });
      expect(personal.rows.map((row) => row.id)).toEqual([person.person.id]);
      expect(personal.segments).toEqual([]);
      expect(personal.anchors).toEqual([]);

      const taskGrouped = await getTimeCanvasData({
        actor: actor(person),
        input: canvasInput({
          scope: { kind: "DASHBOARD" },
          groupBy: "TASK",
        }),
      });
      expect(taskGrouped.rows).toEqual([]);
      expect(taskGrouped.segments).toEqual([]);
      expect(taskGrouped.anchors).toEqual([]);
    });
});
