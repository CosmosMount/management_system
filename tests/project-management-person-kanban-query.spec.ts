// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  getAdaptiveTimeCanvasBlock,
  getPersonTimelinePageData,
} from "../lib/project-management/queries/time-canvas-queries";
import {
  actor,
  atHour,
  createAccountPerson,
  createSegment,
  createTask,
  expectErrorCode,
  grantGlobalProjectAdministrator,
} from "./helpers/project-management-canvas-security-fixtures";

test.describe("project management person kanban query", () => {
  test("ordinary viewers receive one person's complete timeline and active participating plans", async () => {
    const viewer = await createAccountPerson(`看板旁观者 ${randomUUID()}`);
    const target = await createAccountPerson(`看板目标人员 ${randomUUID()}`);
    const other = await createAccountPerson(`看板其他人员 ${randomUUID()}`);
    const guardAdministrator = await createAccountPerson(
      `看板数据库门禁管理员 ${randomUUID()}`,
    );
    await grantGlobalProjectAdministrator(guardAdministrator.account.id);
    const activeTask = await createTask({
      ownerAccountId: target.account.id,
      title: `看板进行中 Task ${randomUUID()}`,
      team: "英雄",
      techGroup: "电控",
      members: [{ personId: target.person.id, role: "OWNER" }],
    });
    const completedTask = await createTask({
      ownerAccountId: target.account.id,
      title: `看板已完成 Task ${randomUUID()}`,
      team: "英雄",
      techGroup: "电控",
      status: "COMPLETED",
      members: [{ personId: target.person.id, role: "OWNER" }],
    });
    const removedTask = await createTask({
      ownerAccountId: target.account.id,
      title: `看板已退出 Task ${randomUUID()}`,
      team: "英雄",
      techGroup: "电控",
      members: [{ personId: target.person.id, role: "PARTICIPANT" }],
    });
    await prisma.taskMember.updateMany({
      where: {
        taskId: removedTask.taskId,
        personId: target.person.id,
        removedAt: null,
      },
      data: { removedAt: atHour(8.5) },
    });
    const otherTask = await createTask({
      ownerAccountId: other.account.id,
      title: `看板无关 Task ${randomUUID()}`,
      team: "英雄",
      techGroup: "电控",
      members: [{ personId: other.person.id, role: "OWNER" }],
    });
    const targetSegments = await Promise.all([
      createSegment({
        accountId: target.account.id,
        personId: target.person.id,
        taskId: activeTask.taskId,
        startAt: atHour(9),
        endAt: atHour(10),
        content: "看板进行中 Task 投入",
      }),
      createSegment({
        accountId: target.account.id,
        personId: target.person.id,
        taskId: completedTask.taskId,
        type: "ACTUAL",
        startAt: atHour(10),
        endAt: atHour(11),
        content: "看板终态 Task 历史投入",
      }),
      createSegment({
        accountId: target.account.id,
        personId: target.person.id,
        taskId: removedTask.taskId,
        startAt: atHour(11),
        endAt: atHour(12),
        content: "看板已退出 Task 历史投入",
      }),
    ]);
    const otherSegment = await createSegment({
      accountId: other.account.id,
      personId: other.person.id,
      taskId: otherTask.taskId,
      startAt: atHour(9),
      endAt: atHour(10),
      content: "看板不应返回的其他人员投入",
    });

    const result = await getPersonTimelinePageData({
      actor: actor(viewer),
      input: { personId: target.person.id },
      preferredCenterMs: atHour(10).getTime(),
      load: { mode: "INITIAL" },
    });

    expect(result.person.id).toBe(target.person.id);
    expect(result.tasks.map((task) => task.id)).toEqual([activeTask.taskId]);
    expect(result.data.rows.map((row) => row.id)).toEqual([target.person.id]);
    expect(result.data.anchors.map((task) => task.id)).toEqual([
      activeTask.taskId,
    ]);
    const segmentIds = result.data.segments.flatMap((segment) =>
      segment.kind === "SEGMENT" ? [segment.id] : [],
    );
    expect(segmentIds).toEqual(
      expect.arrayContaining(targetSegments.map((segment) => segment.id)),
    );
    expect(segmentIds).not.toContain(otherSegment.id);

    const disjointCenterMs = Date.parse("2022-08-10T10:00:00.000Z");
    const disjointResult = await getPersonTimelinePageData({
      actor: actor(viewer),
      input: { personId: target.person.id },
      preferredCenterMs: disjointCenterMs,
      load: { mode: "INITIAL" },
    });
    expect(disjointResult.resolvedCenterMs).toBe(disjointCenterMs);
    expect(disjointResult.fullRange.startMs).toBeLessThanOrEqual(disjointCenterMs);
    expect(disjointResult.fullRange.endMs).toBeGreaterThan(disjointCenterMs);
    expect(disjointResult.loadedRange.startMs).toBeLessThanOrEqual(disjointCenterMs);
    expect(disjointResult.loadedRange.endMs).toBeGreaterThan(disjointCenterMs);
    expect(
      disjointResult.data.segments.filter((segment) => segment.kind === "SEGMENT"),
    ).toEqual([]);

    const block = await getAdaptiveTimeCanvasBlock({
      actor: actor(viewer),
      input: {
        kind: "PERSON_TIMELINE",
        personId: target.person.id,
        rowPageKey: result.data.rowPageKey,
        preferredCenter: atHour(10).toISOString(),
        blockStart: new Date(result.loadedRange.startMs).toISOString(),
        blockEnd: new Date(result.loadedRange.endMs).toISOString(),
      },
    });
    expect(
      block.segments.every((segment) => segment.personId === target.person.id),
    ).toBe(true);
    await expectErrorCode(
      getAdaptiveTimeCanvasBlock({
        actor: actor(viewer),
        input: {
          kind: "PERSON_TIMELINE",
          personId: other.person.id,
          rowPageKey: result.data.rowPageKey,
          preferredCenter: atHour(10).toISOString(),
          blockStart: new Date(result.loadedRange.startMs).toISOString(),
          blockEnd: new Date(result.loadedRange.endMs).toISOString(),
        },
      }),
      "STATE_CONFLICT",
    );

    await prisma.person.update({
      where: { id: target.person.id },
      data: { status: "INACTIVE" },
    });
    await expectErrorCode(
      getPersonTimelinePageData({
        actor: actor(viewer),
        input: { personId: target.person.id },
      }),
      "NOT_FOUND",
    );
    const inactiveSelfResult = await getPersonTimelinePageData({
      actor: actor(target),
      input: { personId: target.person.id },
      preferredCenterMs: atHour(10).getTime(),
      load: { mode: "INITIAL" },
    });
    expect(inactiveSelfResult.data.rows.map((row) => row.id)).toEqual([
      target.person.id,
    ]);
    expect(
      inactiveSelfResult.data.segments.flatMap((segment) =>
        segment.kind === "SEGMENT" ? [segment.id] : [],
      ),
    ).toEqual(expect.arrayContaining(targetSegments.map((segment) => segment.id)));
    await expectErrorCode(
      getPersonTimelinePageData({
        actor: actor(viewer),
        input: { personId: other.person.id, actorPersonId: target.person.id },
      }),
      "VALIDATION_ERROR",
    );
  });
});
