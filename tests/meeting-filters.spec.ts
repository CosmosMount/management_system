// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { getMeetingFilterPeople, listMeetings } from "../lib/project-management/meetings/service";
import { parseMeetingListCursor } from "../lib/project-management/meetings/validation";
import { actor, createAccountPerson, createTask, expectErrorCode } from "./helpers/project-management-canvas-security-fixtures";

test("会议组合筛选包含停用历史人员、直接关联和北京时间区间交集", async () => {
  const owner = await createAccountPerson(`筛选创建人 ${randomUUID()}`);
  const viewer = await createAccountPerson(`筛选查看人 ${randomUUID()}`);
  await prisma.systemRoleAssignment.create({ data: { accountId: viewer.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const project = await prisma.project.create({ data: { name: `筛选项目 ${randomUUID()}`, description: "", requesterAccountId: owner.account.id } });
  const task = await createTask({ ownerAccountId: owner.account.id, title: "筛选任务", team: "英雄", techGroup: "电控", members: [{ personId: owner.person.id, role: "OWNER" }] });
  const prefix = `组合筛选 ${randomUUID()}`;
  const record = await prisma.meetingRecord.create({ data: {
    topic: prefix, rangeStart: new Date("2026-08-31T16:00:00Z"), rangeEnd: new Date("2026-09-02T16:00:00Z"),
    createdByAccountId: owner.account.id, participants: { create: { personId: owner.person.id } },
    timelineDisplay: { projectIds: [project.id], taskIds: [task.taskId] },
  } });
  const blank = await prisma.meetingRecord.create({ data: { topic: `${prefix} 未关联`, rangeStart: record.rangeStart, rangeEnd: record.rangeEnd, createdByAccountId: viewer.account.id } });
  await prisma.person.update({ where: { id: owner.person.id }, data: { status: "INACTIVE" } });
  const filters = { query: prefix, personId: owner.person.id, projectId: project.id, taskId: task.taskId, period: "custom", dateFrom: "2026-09-02", dateTo: "2026-09-02" };
  expect((await listMeetings(filters, actor(viewer))).items.map((entry) => entry.id)).toEqual([record.id]);
  expect((await getMeetingFilterPeople({ query: owner.person.displayName })).items).toContainEqual({ id: owner.person.id, displayName: owner.person.displayName, status: "INACTIVE" });
  expect((await listMeetings({ query: prefix, projectId: "none", taskId: "none" }, actor(viewer))).items.map((entry) => entry.id)).toEqual([blank.id]);
  expect((await listMeetings({ query: prefix, mine: true }, actor(viewer))).items.map((entry) => entry.id)).toEqual([blank.id]);
  expect((await listMeetings({ ...filters, dateFrom: "2026-09-03", dateTo: "2026-09-03" }, actor(viewer))).items).toHaveLength(0);
  expect((await listMeetings({ ...filters, dateFrom: "2026-08-31", dateTo: "2026-08-31" }, actor(viewer))).items).toHaveLength(0);
  await expectErrorCode(listMeetings({ mine: true }), "FORBIDDEN");
  await expectErrorCode(listMeetings({ personId: randomUUID() }, actor(viewer)), "NOT_FOUND");
  await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });
  await expectErrorCode(listMeetings(filters, actor(viewer)), "NOT_FOUND");
  expect((await listMeetings({ query: prefix }, actor(viewer))).items).toHaveLength(2);
  await prisma.task.update({ where: { id: task.taskId }, data: { deletedAt: new Date() } });
  await expectErrorCode(listMeetings({ query: prefix, taskId: task.taskId }, actor(viewer)), "NOT_FOUND");
});

test("会议三种排序分页稳定、保留条件并拒绝不匹配的游标", async () => {
  const owner = await createAccountPerson(`排序创建人 ${randomUUID()}`);
  const prefix = `分页筛选 ${randomUUID()}`;
  await prisma.meetingRecord.createMany({ data: Array.from({ length: 28 }, (_, index) => ({
    topic: `${prefix} ${index}`, createdByAccountId: owner.account.id,
    createdAt: new Date("2026-09-01T00:00:00Z"), updatedAt: new Date("2026-09-02T00:00:00Z"),
    rangeStart: new Date("2026-09-01T00:00:00Z"), rangeEnd: new Date("2026-09-03T00:00:00Z"),
  })) });
  for (const sort of ["createdAt", "updatedAt", "rangeStart"]) {
    const filters = { query: prefix, sort, mine: true, projectId: "none", period: "custom", dateFrom: "2026-09-02", dateTo: "2026-09-02" };
    const first = await listMeetings(filters, actor(owner));
    expect(first.items).toHaveLength(25);
    const second = await listMeetings({ ...filters, cursor: first.nextCursor }, actor(owner));
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((entry) => entry.id)).size).toBe(28);
    await expectErrorCode(listMeetings({ ...filters, query: "不存在的主题", cursor: first.nextCursor }, actor(owner)), "VALIDATION_ERROR");
  }
});

test("最近工作区间筛选排除未来，分别覆盖7、30、90天", async () => {
  const owner = await createAccountPerson(`近期会议 ${randomUUID()}`);
  const prefix = `近期筛选 ${randomUUID()}`;
  const now = Date.now();
  await prisma.meetingRecord.createMany({ data: [1, 10, 40, 100, -1].map((days) => ({
    topic: `${prefix} ${days}`, createdByAccountId: owner.account.id,
    rangeStart: new Date(now - days * 86_400_000), rangeEnd: new Date(now - days * 86_400_000 + 3_600_000),
  })) });
  for (const [period, count] of [["7", 1], ["30", 2], ["90", 3]] as const) {
    expect((await listMeetings({ query: prefix, period }, actor(owner))).items).toHaveLength(count);
  }
});

test("会议排序分别使用对应时间字段而非固定创建时间", async () => {
  const owner = await createAccountPerson(`排序字段 ${randomUUID()}`);
  const prefix = `排序字段 ${randomUUID()}`;
  const first = await prisma.meetingRecord.create({ data: { topic: `${prefix} A`, createdByAccountId: owner.account.id, createdAt: new Date("2026-09-03T00:00:00Z"), updatedAt: new Date("2026-09-01T00:00:00Z"), rangeStart: new Date("2026-09-01T00:00:00Z"), rangeEnd: new Date("2026-09-04T00:00:00Z") } });
  const second = await prisma.meetingRecord.create({ data: { topic: `${prefix} B`, createdByAccountId: owner.account.id, createdAt: new Date("2026-09-02T00:00:00Z"), updatedAt: new Date("2026-09-03T00:00:00Z"), rangeStart: new Date("2026-09-02T00:00:00Z"), rangeEnd: new Date("2026-09-04T00:00:00Z") } });
  expect((await listMeetings({ query: prefix })).items.map((entry) => entry.id)).toEqual([first.id, second.id]);
  for (const sort of ["updatedAt", "rangeStart"]) expect((await listMeetings({ query: prefix, sort })).items.map((entry) => entry.id)).toEqual([second.id, first.id]);
});

test("编辑分页边界会议后沿用原始排序位置和时间窗口", async () => {
  const owner = await createAccountPerson(`游标稳定性 ${randomUUID()}`);
  for (const sort of ["createdAt", "updatedAt", "rangeStart"] as const) {
    const prefix = `边界编辑 ${sort} ${randomUUID()}`;
    const now = Date.now();
    await prisma.meetingRecord.createMany({ data: Array.from({ length: 28 }, (_, index) => ({
      topic: prefix, createdByAccountId: owner.account.id,
      createdAt: new Date(now - index * 1000), updatedAt: new Date(now - index * 1000),
      rangeStart: new Date(now - index * 1000), rangeEnd: new Date(now + 3_600_000),
    })) });
    const input = { query: prefix, sort, period: "7" };
    const first = await listMeetings(input, actor(owner));
    const boundary = parseMeetingListCursor(first.nextCursor!);
    expect(boundary).not.toBeNull();
    const expected = await listMeetings({ ...input, cursor: first.nextCursor }, actor(owner));
    await prisma.meetingRecord.update({ where: { id: boundary!.id }, data: { topic: "改名后的边界会议", rangeStart: new Date(now - 20 * 86_400_000) } });
    const second = await listMeetings({ ...input, cursor: first.nextCursor }, actor(owner));
    expect(second.items.map((entry) => entry.id)).toEqual(expected.items.map((entry) => entry.id));
    expect(second.items).toHaveLength(3);
    expect(new Set([...first.items, ...second.items].map((entry) => entry.id)).size).toBe(28);
    const remainingId = expected.items[0].id;
    await prisma.meetingRecord.update({ where: { id: remainingId }, data: { rangeStart: new Date(now - 7 * 86_400_000 - 3_600_000), updatedAt: new Date(expected.items[0].updatedAt) } });
    const historicalCursor = JSON.stringify({ ...boundary, asOf: new Date(now - 2 * 3_600_000).toISOString() });
    expect((await listMeetings({ ...input, cursor: historicalCursor }, actor(owner))).items.map((entry) => entry.id)).toContain(remainingId);
  }
});
