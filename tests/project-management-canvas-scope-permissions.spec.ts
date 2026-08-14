import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { getMyWorkDashboard } from "../lib/project-management/queries/dashboard-queries";
import { getTimeCanvasData } from "../lib/project-management/queries/time-canvas-queries";

import {
  RANGE_END,
  RANGE_START,
  actor,
  atHour,
  canvasInput,
  createAccountPerson,
  createSegment,
  createTask,
  expectErrorCode,
  fullSegmentIds,
  systemAdministratorRole,
} from "./helpers/project-management-canvas-security-fixtures";

test.describe("project management canvas security project-management-canvas-scope-permissions", () => {
  test("four canvas scopes enforce row domains, half-open filters, global Full visibility and Actual capabilities", async () => {
      const scopeKey = randomUUID();
      const scopedTeam = `英雄-${scopeKey}`;
      const scopedTechGroup = `电控-${scopeKey}`;
      const owner = await createAccountPerson("画布 Owner");
      const member = await createAccountPerson("画布 Member");
      const hiddenOwner = await createAccountPerson("隐藏 Owner");
      const inactive = await createAccountPerson("停用画布人员", "INACTIVE");
      const inactiveWithHistory = await createAccountPerson(
        "有历史投入的停用画布人员",
        "INACTIVE",
      );
      const ownerActor = actor(owner);
      const adminActor = actor(owner, [systemAdministratorRole()]);
      const taskA = await createTask({
        ownerAccountId: owner.account.id,
        title: "可见 Task A",
        team: scopedTeam,
        techGroup: scopedTechGroup,
        plannedStartAt: null,
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: member.person.id, role: "PARTICIPANT" },
        ],
      });
      const taskB = await createTask({
        ownerAccountId: hiddenOwner.account.id,
        title: "隐藏 Task B",
        team: "步兵",
        techGroup: "机械",
        members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
      });
      await prisma.taskMember.create({
        data: {
          taskId: taskB.taskId,
          personId: inactiveWithHistory.person.id,
          role: "PARTICIPANT",
        },
      });
      const current = await createSegment({
        accountId: owner.account.id,
        personId: member.person.id,
        taskId: taskA.taskId,
        startAt: atHour(9),
        endAt: atHour(12),
        content: "可见 Task A 投入",
      });
      const hidden = await createSegment({
        accountId: hiddenOwner.account.id,
        personId: member.person.id,
        taskId: taskB.taskId,
        startAt: atHour(10),
        endAt: atHour(11),
        content: "绝密 Task B 投入",
      });
      const inactiveHistory = await createSegment({
        accountId: hiddenOwner.account.id,
        personId: inactiveWithHistory.person.id,
        taskId: taskB.taskId,
        startAt: atHour(15),
        endAt: atHour(16),
        content: "停用人员历史投入",
      });
      const hiddenVersionToken = "2026-07-01T01:02:03.456Z";
      await prisma.workSegment.update({
        where: { id: hidden.id },
        data: { updatedAt: new Date(hiddenVersionToken) },
      });
      const actual = await createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        taskId: taskA.taskId,
        type: "ACTUAL",
        status: "CONFIRMED",
        startAt: atHour(13),
        endAt: atHour(14),
        content: "本人 Actual",
      });
      const endingAtRangeStart = await createSegment({
        accountId: owner.account.id,
        personId: member.person.id,
        taskId: taskA.taskId,
        startAt: new Date("2026-08-09T23:00:00.000Z"),
        endAt: new Date(RANGE_START),
        content: "恰好结束于范围起点",
      });
      const startingAtRangeEnd = await createSegment({
        accountId: owner.account.id,
        personId: member.person.id,
        taskId: taskA.taskId,
        startAt: new Date(RANGE_END),
        endAt: new Date("2026-08-12T01:00:00.000Z"),
        content: "恰好开始于范围终点",
      });
      const crossingRangeStart = await createSegment({
        accountId: owner.account.id,
        personId: member.person.id,
        taskId: taskA.taskId,
        startAt: new Date("2026-08-09T23:00:00.000Z"),
        endAt: new Date("2026-08-10T01:00:00.000Z"),
        content: "跨过范围起点",
      });
      const taskCanvas = await getTimeCanvasData({
        actor: ownerActor,
        input: canvasInput({
          scope: { kind: "TASK_SCOPED", taskId: taskA.taskId },
          groupBy: "PERSON",
          includeBusyBlocks: true,
        }),
      });
      expect(taskCanvas.rows.map((row) => row.id)).toEqual(
        expect.arrayContaining([owner.person.id, member.person.id]),
      );
      const fullCurrent = taskCanvas.segments.find(
        (segment) => segment.kind === "SEGMENT" && segment.id === current.id,
      );
      expect(fullCurrent).toMatchObject({
        kind: "SEGMENT",
        visibility: "FULL",
        versionToken: current.updatedAt.toISOString(),
      });
      expect(taskCanvas.segments.some((segment) => segment.kind === "BUSY")).toBe(
        false,
      );
      expect(taskCanvas.segments).toContainEqual(
        expect.objectContaining({
          kind: "SEGMENT",
          visibility: "FULL",
          id: hidden.id,
          content: "绝密 Task B 投入",
          taskId: taskB.taskId,
          versionToken: hiddenVersionToken,
        }),
      );
      const serializedTaskCanvas = JSON.stringify(taskCanvas);
      for (const visible of [
        hidden.id,
        "绝密 Task B 投入",
        taskB.taskId,
        hiddenVersionToken,
      ]) {
        expect(serializedTaskCanvas).toContain(visible);
      }
      expect(fullSegmentIds(taskCanvas)).toContain(crossingRangeStart.id);
      expect(fullSegmentIds(taskCanvas)).not.toContain(endingAtRangeStart.id);
      expect(fullSegmentIds(taskCanvas)).not.toContain(startingAtRangeEnd.id);
      expect(taskCanvas.anchors[0]?.plannedStartAt).toBeNull();
      const actualDto = taskCanvas.segments.find(
        (segment) => segment.kind === "SEGMENT" && segment.id === actual.id,
      );
      expect(actualDto?.kind).toBe("SEGMENT");
      if (actualDto?.kind !== "SEGMENT") throw new Error("Actual DTO 缺失");
      expect(actualDto.permissions).toMatchObject({
        canEdit: true,
        canMove: false,
        canResize: false,
        canMerge: false,
        canCancel: false,
        canConfirm: false,
        canSoftDelete: true,
      });
      for (const scope of ["PERSONAL", "DASHBOARD"] as const) {
        const canvas = await getTimeCanvasData({
          actor: ownerActor,
          input: canvasInput({ scope: { kind: scope }, groupBy: "PERSON" }),
        });
        expect(canvas.rows.map((row) => row.id)).toEqual([owner.person.id]);
        expect(
          canvas.segments.every((segment) => segment.personId === owner.person.id),
        ).toBe(true);
      }
      for (const scope of ["PERSONAL", "DASHBOARD"] as const) {
        const canvas = await getTimeCanvasData({
          actor: ownerActor,
          input: canvasInput({
            scope: { kind: scope },
            groupBy: "TASK",
          }),
        });
        expect(canvas.rows.map((row) => row.id)).toContain(taskA.taskId);
        expect(
          canvas.segments.every(
            (segment) => segment.personId === owner.person.id,
          ),
        ).toBe(true);
      }
      const ordinaryResource = await getTimeCanvasData({
        actor: ownerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [owner.person.id, member.person.id, hiddenOwner.person.id],
        }),
      });
      expect(ordinaryResource.rows.map((row) => row.id)).toEqual(
        expect.arrayContaining([
          owner.person.id,
          member.person.id,
          hiddenOwner.person.id,
        ]),
      );
      const globallyVisibleHidden = ordinaryResource.segments.find(
        (segment) => segment.kind === "SEGMENT" && segment.id === hidden.id,
      );
      expect(globallyVisibleHidden).toMatchObject({
        kind: "SEGMENT",
        visibility: "FULL",
        content: "绝密 Task B 投入",
        taskId: taskB.taskId,
        versionToken: hiddenVersionToken,
      });
      const taskGrouped = await getTimeCanvasData({
        actor: ownerActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "TASK",
          taskIds: [taskA.taskId, taskB.taskId],
        }),
      });
      expect(taskGrouped.rows.map((row) => row.id)).toContain(taskA.taskId);
      expect(taskGrouped.rows.map((row) => row.id)).toContain(taskB.taskId);
      expect(taskGrouped.segments.every((segment) => segment.kind === "SEGMENT"))
        .toBe(true);

      expect(
        (
          await getTimeCanvasData({
            actor: ownerActor,
            input: canvasInput({
              scope: { kind: "RESOURCE_PLANNER" },
              groupBy: "PERSON",
              personIds: [member.person.id],
            }),
          })
        ).rows.map((row) => row.id),
      ).toContain(member.person.id);
      expect(
        fullSegmentIds(
          await getTimeCanvasData({
            actor: ownerActor,
            input: canvasInput({
              scope: { kind: "RESOURCE_PLANNER" },
              groupBy: "PERSON",
              personIds: [member.person.id],
              taskIds: [taskB.taskId],
            }),
          }),
        ),
      ).toContain(hidden.id);
      await expectErrorCode(
        getTimeCanvasData({
          actor: adminActor,
          input: canvasInput({
            scope: { kind: "RESOURCE_PLANNER" },
            groupBy: "PERSON",
            personIds: [inactive.person.id],
          }),
        }),
        "NOT_FOUND",
      );
      const inactiveHistoryCanvas = await getTimeCanvasData({
        actor: adminActor,
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [inactiveWithHistory.person.id],
        }),
      });
      expect(inactiveHistoryCanvas.rows).toEqual([
        expect.objectContaining({
          id: inactiveWithHistory.person.id,
          label: "有历史投入的停用画布人员（已停用）",
          capabilities: { canCreateSegment: false },
        }),
      ]);
      expect(fullSegmentIds(inactiveHistoryCanvas)).toContain(
        inactiveHistory.id,
      );

      const completeTaskRows = await getTimeCanvasData({
        actor: ownerActor,
        input: canvasInput({
          scope: { kind: "TASK_SCOPED", taskId: taskA.taskId },
          groupBy: "PERSON",
        }),
      });
      expect(completeTaskRows.rows.map((row) => row.id)).toEqual(
        expect.arrayContaining([owner.person.id, member.person.id]),
      );
    });

  test("globally visible Full segments exclude exact half-open boundaries and keep adjacent intersections", async () => {
      const owner = await createAccountPerson("半开边界 Owner");
      const target = await createAccountPerson("半开边界目标");
      const hiddenOwner = await createAccountPerson("半开边界隐藏 Owner");
      await createTask({
        ownerAccountId: owner.account.id,
        title: "半开边界可见 Task",
        team: "英雄",
        techGroup: "电控",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: target.person.id, role: "PARTICIPANT" },
        ],
      });
      const hiddenTask = await createTask({
        ownerAccountId: hiddenOwner.account.id,
        title: "半开边界隐藏 Task",
        team: "步兵",
        techGroup: "机械",
        members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
      });
      const rangeStart = new Date(RANGE_START);
      const rangeEnd = new Date(RANGE_END);
      const justAfterRangeStart = new Date(rangeStart.getTime() + 1);
      const justBeforeRangeEnd = new Date(rangeEnd.getTime() - 1);
      const beforeRangeStart = new Date(rangeStart.getTime() - 60 * 60 * 1_000);
      const afterRangeEnd = new Date(rangeEnd.getTime() + 60 * 60 * 1_000);
      const busyFixtures = await Promise.all([
        createSegment({
          accountId: hiddenOwner.account.id,
          personId: target.person.id,
          taskId: hiddenTask.taskId,
          startAt: beforeRangeStart,
          endAt: rangeStart,
          content: "Busy 恰好结束于 rangeStart",
        }),
        createSegment({
          accountId: hiddenOwner.account.id,
          personId: target.person.id,
          taskId: hiddenTask.taskId,
          startAt: beforeRangeStart,
          endAt: justAfterRangeStart,
          content: "Busy 刚跨过 rangeStart",
        }),
        createSegment({
          accountId: hiddenOwner.account.id,
          personId: target.person.id,
          taskId: hiddenTask.taskId,
          startAt: rangeEnd,
          endAt: afterRangeEnd,
          content: "Busy 恰好开始于 rangeEnd",
        }),
        createSegment({
          accountId: hiddenOwner.account.id,
          personId: target.person.id,
          taskId: hiddenTask.taskId,
          startAt: justBeforeRangeEnd,
          endAt: afterRangeEnd,
          content: "Busy 刚跨入 rangeEnd",
        }),
      ]);
      const canvas = await getTimeCanvasData({
        actor: actor(owner),
        input: canvasInput({
          scope: { kind: "RESOURCE_PLANNER" },
          groupBy: "PERSON",
          personIds: [target.person.id],
          includeBusyBlocks: true,
        }),
      });
      const visibleRanges = canvas.segments.flatMap((segment) =>
        segment.kind === "SEGMENT" && segment.taskId === hiddenTask.taskId
          ? [`${segment.startAt}|${segment.endAt}`]
          : [],
      );
      expect(visibleRanges).toEqual(
        expect.arrayContaining([
          `${busyFixtures[1]!.startAt.toISOString()}|${busyFixtures[1]!.endAt.toISOString()}`,
          `${busyFixtures[3]!.startAt.toISOString()}|${busyFixtures[3]!.endAt.toISOString()}`,
        ]),
      );
      expect(visibleRanges).not.toContain(
        `${busyFixtures[0]!.startAt.toISOString()}|${busyFixtures[0]!.endAt.toISOString()}`,
      );
      expect(visibleRanges).not.toContain(
        `${busyFixtures[2]!.startAt.toISOString()}|${busyFixtures[2]!.endAt.toISOString()}`,
      );
    });

  test("globally visible equal-time Full segments use stable IDs as a tie-breaker", async () => {
      const owner = await createAccountPerson("Busy 稳定排序 Owner");
      const target = await createAccountPerson("Busy 稳定排序目标");
      const hiddenOwner = await createAccountPerson("Busy 稳定排序隐藏 Owner");
      await createTask({
        ownerAccountId: owner.account.id,
        title: "Busy 稳定排序可见 Task",
        team: "英雄",
        techGroup: "电控",
        members: [
          { personId: owner.person.id, role: "OWNER" },
          { personId: target.person.id, role: "PARTICIPANT" },
        ],
      });
      const hiddenTaskTitle = `Busy 稳定排序绝密 Task ${randomUUID()}`;
      const hiddenTask = await createTask({
        ownerAccountId: hiddenOwner.account.id,
        title: hiddenTaskTitle,
        team: "步兵",
        techGroup: "机械",
        members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
      });
      const hiddenIdPrefix = randomUUID().slice(0, -1);
      const hiddenSegmentFixtures = Array.from({ length: 8 }, (_, index) => ({
        id: `${hiddenIdPrefix}${index.toString(16)}`,
        content: `Busy 稳定排序绝密投入 ${index}`,
      }));
      const hiddenSegments = [];
      for (const fixture of [...hiddenSegmentFixtures].reverse()) {
        hiddenSegments.push(
          await createSegment({
            id: fixture.id,
            accountId: hiddenOwner.account.id,
            personId: target.person.id,
            taskId: hiddenTask.taskId,
            startAt: atHour(9),
            endAt: atHour(10),
            content: fixture.content,
          }),
        );
      }

      const loadEqualKeyFullSegments = async () => {
        const canvas = await getTimeCanvasData({
          actor: actor(owner),
          input: canvasInput({
            scope: { kind: "RESOURCE_PLANNER" },
            groupBy: "PERSON",
            personIds: [target.person.id],
            includeBusyBlocks: true,
          }),
        });
        return canvas.segments.filter(
          (segment) =>
            segment.kind === "SEGMENT" &&
            segment.taskId === hiddenTask.taskId &&
            segment.personId === target.person.id &&
            segment.startAt === atHour(9).toISOString() &&
            segment.endAt === atHour(10).toISOString(),
        );
      };
      const firstRead = await loadEqualKeyFullSegments();
      const secondRead = await loadEqualKeyFullSegments();
      expect(firstRead).toHaveLength(hiddenSegments.length);
      expect(secondRead).toEqual(firstRead);
      expect(
        firstRead.flatMap((segment) =>
          segment.kind === "SEGMENT" ? [segment.id] : [],
        ),
      ).toEqual(
        hiddenSegments.map((segment) => segment.id).sort(),
      );
      const serializedFull = JSON.stringify(firstRead);
      for (const visible of [
        ...hiddenSegments.flatMap((segment) => [segment.id, segment.content]),
        hiddenTask.taskId,
      ]) {
        expect(serializedFull).toContain(visible);
      }
    });

  test("dashboard basis contains only the actor's visible active work and own unread notifications", async () => {
      const owner = await createAccountPerson("Dashboard Owner");
      const hiddenOwner = await createAccountPerson("Dashboard Hidden Owner");
      const visibleTask = await createTask({
        ownerAccountId: owner.account.id,
        title: "Dashboard 可见 Active",
        team: "英雄",
        techGroup: "电控",
        members: [{ personId: owner.person.id, role: "OWNER" }],
      });
      const hiddenTask = await createTask({
        ownerAccountId: hiddenOwner.account.id,
        title: "Dashboard 隐藏 Active",
        team: "步兵",
        techGroup: "机械",
        members: [{ personId: hiddenOwner.person.id, role: "OWNER" }],
      });
      const pending = await createSegment({
        accountId: owner.account.id,
        personId: owner.person.id,
        taskId: visibleTask.taskId,
        status: "PENDING_CONFIRMATION",
        startAt: atHour(9),
        endAt: atHour(10),
        content: "Dashboard 待确认",
      });
      await createSegment({
        accountId: hiddenOwner.account.id,
        personId: hiddenOwner.person.id,
        taskId: hiddenTask.taskId,
        startAt: atHour(9),
        endAt: atHour(10),
        content: "Dashboard 他人安排",
      });
      await prisma.inAppNotification.createMany({
        data: [
          {
            recipientAccountId: owner.account.id,
            category: "TASK",
            title: "本人未读",
            entityType: "Task",
            entityId: visibleTask.taskId,
            taskId: visibleTask.taskId,
          },
          {
            recipientAccountId: hiddenOwner.account.id,
            category: "TASK",
            title: "他人未读",
            entityType: "Task",
            entityId: hiddenTask.taskId,
            taskId: hiddenTask.taskId,
          },
        ],
      });
      const dashboard = await getMyWorkDashboard({
        actor: actor(owner),
        input: { rangeStart: RANGE_START, rangeEnd: RANGE_END },
      });
      expect(dashboard.activeTasks.map((task) => task.id)).toContain(
        visibleTask.taskId,
      );
      expect(dashboard.activeTasks.map((task) => task.id)).not.toContain(
        hiddenTask.taskId,
      );
      expect(dashboard.personalTime.rows.map((row) => row.id)).toEqual([
        owner.person.id,
      ]);
      expect(dashboard.pendingConfirmations.map((segment) => segment.id)).toEqual([
        pending.id,
      ]);
      expect(dashboard.unreadNotificationCount).toBe(1);
    });
});
