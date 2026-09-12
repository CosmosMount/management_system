import { listMeetingMissingPeople, urgeMeetingWorkSegments } from "../lib/project-management/application/meeting-urge-service";
// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createMeeting, updateMeeting, getMeeting, listMeetings } from "../lib/project-management/meetings/service";
import { getMeetingTimeline } from "../lib/project-management/meetings/timeline";
import { actor, atHour, createAccountPerson, createSegment, createTask, expectErrorCode } from "./helpers/project-management-canvas-security-fixtures";

async function fixture() {
  const admin = await createAccountPerson(`会议超管 ${randomUUID()}`);
  const viewer = await createAccountPerson(`会议旁观者 ${randomUUID()}`);
  const participant = await createAccountPerson(`会议参与人 ${randomUUID()}`);
  const role = await prisma.systemRoleAssignment.create({ data: { accountId: admin.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const input = {
    requestId: randomUUID(), topic: `独立会议 ${randomUUID()}`, personIds: [participant.person.id], minutes: "会议讨论与结论",
    rangeStart: atHour(8).toISOString(), rangeEnd: atHour(18).toISOString(),
  };
  return { admin, viewer, participant, role, input };
}

test("会议展示配置只读、动态展开项目、任务迁移及删除兼容", async () => {
  const { admin, viewer, participant, input } = await fixture();
  const project = await prisma.project.create({ data: { name: `展示项目 ${randomUUID()}`, description: "会议展示", requesterAccountId: admin.account.id } });
  const task = await createTask({ ownerAccountId: viewer.account.id, title: "会议展示任务", team: "英雄", techGroup: "电控", members: [{ personId: viewer.person.id, role: "OWNER" }] });
  await prisma.task.update({ where: { id: task.taskId }, data: { projectId: project.id } });
  const timelineDisplay = { projectIds: [project.id], taskIds: [task.taskId] };
  const created = await createMeeting(actor(admin), { ...input, timelineDisplay });
  expect(created.timelineDisplay).toEqual(timelineDisplay);
  expect((await createMeeting(actor(admin), { ...input, timelineDisplay: { ...timelineDisplay, taskIds: [task.taskId, task.taskId] } })).id).toBe(created.id);
  const query = { kind: "SAVED", meetingId: created.id, rangeStart: input.rangeStart, rangeEnd: input.rangeEnd };
  const emptyPlan = await getMeetingTimeline(actor(viewer), query);
  expect(emptyPlan.anchors.map((anchor) => anchor.id)).toEqual([task.taskId]);
  expect(emptyPlan.anchors[0]).toMatchObject({ title: "会议展示任务", project: { id: project.id, name: project.name } });
  const preview = await getMeetingTimeline(actor(admin, [{ role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" }]), { kind: "PREVIEW", personIds: input.personIds, rangeStart: input.rangeStart, rangeEnd: input.rangeEnd, timelineDisplay });
  expect(preview.anchors[0]).toMatchObject({ title: "会议展示任务", project: { id: project.id, name: project.name } });
  expect(emptyPlan.segments).toEqual([]);
  const segment = await createSegment({ accountId: viewer.account.id, personId: viewer.person.id, taskId: task.taskId, startAt: atHour(9), endAt: atHour(10), content: "额外工作人员" });
  await prisma.person.update({ where: { id: viewer.person.id }, data: { status: "INACTIVE" } });
  const current = await getMeetingTimeline(actor(admin), query);
  expect(current.segments.map((record) => record.kind === "SEGMENT" ? record.id : null)).toEqual([segment.id]);
  expect(current.rows.map((row) => row.id)).toEqual(expect.arrayContaining([participant.person.id, viewer.person.id]));
  expect(current.anchors[0].capabilities.canUpdateMetadata).toBe(false);
  expect(current.anchors[0].nodes.every((node) => !node.capabilities.canEditDraft)).toBe(true);
  expect((await getMeetingTimeline(actor(participant), query)).rowPageKey).toBe(current.rowPageKey);
  expect((await getMeeting({ meetingId: created.id })).participants.map((person) => person.id)).toEqual([participant.person.id]);
  await prisma.task.update({ where: { id: task.taskId }, data: { projectId: null } });
  const detached = await getMeetingTimeline(actor(admin), query);
  expect(detached.anchors).toHaveLength(1);
  expect(detached.anchors[0]).toMatchObject({ title: "会议展示任务", project: null });
  const extra = await createTask({ ownerAccountId: admin.account.id, title: "动态加入任务", team: "英雄", techGroup: "电控", members: [{ personId: admin.person.id, role: "OWNER" }] });
  await prisma.task.update({ where: { id: extra.taskId }, data: { projectId: project.id } });
  expect((await getMeetingTimeline(actor(admin), query)).anchors).toHaveLength(2);
  await prisma.task.update({ where: { id: extra.taskId }, data: { status: "ARCHIVED" } });
  expect((await getMeetingTimeline(actor(admin), query)).anchors.find((anchor) => anchor.id === extra.taskId)?.status).toBe("ARCHIVED");
  await prisma.task.update({ where: { id: task.taskId }, data: { deletedAt: new Date() } });
  const deleted = await getMeetingTimeline(actor(admin), query);
  expect(deleted.display.unavailableTaskCount).toBe(1);
  expect(deleted.anchors).toHaveLength(1);
  expect(deleted.segments).toEqual([]);
  const { requestId, ...fields } = input;
  void requestId;
  const preserved = await updateMeeting(actor(admin), { ...fields, meetingId: created.id, expectedVersion: 0 });
  expect(preserved.timelineDisplay).toEqual(timelineDisplay);
  await expectErrorCode(createMeeting(actor(admin), { ...input, requestId: randomUUID(), timelineDisplay }), "VALIDATION_ERROR");
  const cleared = await updateMeeting(actor(admin), { ...fields, meetingId: created.id, expectedVersion: 1, timelineDisplay: { projectIds: [], taskIds: [] } });
  expect(cleared.timelineDisplay).toEqual({ projectIds: [], taskIds: [] });
});

test("仅全局超管写入；事务审计、幂等创建、角色撤销与停用校验", async () => {
  const { admin, viewer, participant, role, input } = await fixture();
  await expectErrorCode(createMeeting(actor(viewer), input), "FORBIDDEN");
  await prisma.systemRoleAssignment.create({ data: { accountId: viewer.account.id, role: "PROJECT_ADMINISTRATOR", team: "", techGroup: "" } });
  await expectErrorCode(createMeeting(actor(viewer), input), "FORBIDDEN");
  const [created, retry] = await Promise.all([createMeeting(actor(admin), input), createMeeting(actor(admin), input)]);
  expect(created.id).toBe(retry.id);
  expect(await prisma.domainAuditEvent.count({ where: { entityId: created.id, action: "meeting.create" } })).toBe(1);
  expect(await getMeeting({ meetingId: created.id })).toMatchObject({ minutes: input.minutes });
  expect((await listMeetings({ query: input.topic })).items.map((record) => record.id)).toContain(created.id);
  const { requestId: omitted, ...fields } = input;
  void omitted;
  await expectErrorCode(updateMeeting(actor(viewer), { ...fields, meetingId: created.id, expectedVersion: 0 }), "FORBIDDEN");
  await prisma.person.update({ where: { id: participant.person.id }, data: { status: "INACTIVE" } });
  const saved = await updateMeeting(actor(admin), { ...fields, minutes: "停用参与人仍保留", meetingId: created.id, expectedVersion: 0 });
  expect(saved.participants[0].status).toBe("INACTIVE");
  await expectErrorCode(createMeeting(actor(admin), { ...input, requestId: randomUUID() }), "VALIDATION_ERROR");
  await prisma.systemRoleAssignment.update({ where: { id: role.id }, data: { revokedAt: new Date() } });
  await expectErrorCode(updateMeeting(actor(admin, [{ role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" }]), {
    ...fields, meetingId: created.id, expectedVersion: saved.version,
  }), "FORBIDDEN");
  expect(await prisma.notificationOutbox.count({ where: { payload: { contains: created.id } } })).toBe(0);
  expect(await prisma.inAppNotification.count({ where: { entityId: created.id } })).toBe(0);
});

test("并发更新只成功一次，纪要及参与人不被静默覆盖", async () => {
  const { admin, viewer, input } = await fixture();
  const second = await createAccountPerson(`会议第二超管 ${randomUUID()}`);
  await prisma.systemRoleAssignment.create({ data: { accountId: second.account.id, role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" } });
  const meeting = await createMeeting(actor(admin), input);
  const project = await prisma.project.create({ data: { name: "并发展示选择", description: "会议展示", requesterAccountId: admin.account.id } });
  const base = { topic: input.topic, rangeStart: input.rangeStart, rangeEnd: input.rangeEnd, meetingId: meeting.id, expectedVersion: 0 };
  const results = await Promise.allSettled([
    updateMeeting(actor(admin), { ...base, minutes: "结论 A", personIds: input.personIds, timelineDisplay: { projectIds: [project.id], taskIds: [] } }),
    updateMeeting(actor(second), { ...base, minutes: "结论 B", personIds: [viewer.person.id], timelineDisplay: { projectIds: [], taskIds: [] } }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason.code).toBe("STATE_CONFLICT");
  const final = await getMeeting({ meetingId: meeting.id });
  expect(final.version).toBe(1);
  expect(final.timelineDisplay.projectIds).toEqual(final.minutes === "结论 A" ? [project.id] : []);
  expect(final.participants.map((person) => person.id)).toEqual(final.minutes === "结论 A" ? input.personIds : [viewer.person.id]);
  expect(await prisma.domainAuditEvent.count({ where: { entityId: meeting.id, action: "meeting.update" } })).toBe(1);
});

test("所有查看者得到相同的跨项目只读时间线，包括空行、停用人员与实时更新", async () => {
  const { admin, viewer, participant, input } = await fixture();
  const empty = await createAccountPerson(`会议空行 ${randomUUID()}`);
  const meeting = await createMeeting(actor(admin), { ...input, personIds: [participant.person.id, empty.person.id] });
  const segments = [];
  for (const suffix of ["甲", "乙"]) {
    const project = await prisma.project.create({ data: { name: `会议跨项目${suffix}`, description: "会议透明读取", requesterAccountId: admin.account.id } });
    const task = await createTask({ ownerAccountId: participant.account.id, title: `会议任务${suffix}`, team: "英雄", techGroup: "电控", members: [{ personId: participant.person.id, role: "OWNER" }] });
    await prisma.task.update({ where: { id: task.taskId }, data: { projectId: project.id } });
    segments.push(await createSegment({ accountId: participant.account.id, personId: participant.person.id, taskId: task.taskId, startAt: atHour(9), endAt: atHour(10), content: `会议工作${suffix}` }));
  }
  await createSegment({ accountId: viewer.account.id, personId: viewer.person.id, startAt: atHour(9), endAt: atHour(10), content: "非参与人不纳入本会议" });
  await createSegment({ accountId: participant.account.id, personId: participant.person.id, startAt: atHour(18), endAt: atHour(19), content: "半开区间外" });
  await createSegment({ accountId: participant.account.id, personId: participant.person.id, startAt: atHour(9), endAt: atHour(10), deletedAt: new Date(), content: "已删除记录" });
  await prisma.person.update({ where: { id: empty.person.id }, data: { status: "INACTIVE" } });
  const query = { kind: "SAVED", meetingId: meeting.id, rangeStart: input.rangeStart, rangeEnd: input.rangeEnd };
  const ordinary = await getMeetingTimeline(actor(viewer), query);
  const adminResult = await getMeetingTimeline(actor(admin, [{ role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" }]), query);
  expect(ordinary.rows).toEqual(adminResult.rows);
  expect(ordinary.segments).toEqual(adminResult.segments);
  expect(ordinary.rows).toHaveLength(2);
  expect(ordinary.rows.every((row) => !row.capabilities.canCreateSegment)).toBe(true);
  expect(ordinary.segments).toHaveLength(2);
  for (const segment of ordinary.segments) {
    expect(segment.kind).toBe("SEGMENT");
    if (segment.kind === "SEGMENT") {
      expect(segment.taskTitle).toMatch(/会议跨项目[甲乙] \/ 会议任务[甲乙]/);
      expect(segment.permissions).toEqual({ canViewDetails: true, canEdit: false, canMove: false, canResize: false, canSoftDelete: false });
    }
  }
  await prisma.workSegment.update({ where: { id: segments[0].id }, data: { content: "工作已实时更新" } });
  expect((await getMeetingTimeline(actor(viewer), query)).segments).toEqual(expect.arrayContaining([expect.objectContaining({ content: "工作已实时更新" })]));
  await expectErrorCode(getMeetingTimeline(actor(viewer), { ...query, personIds: [viewer.person.id] }), "VALIDATION_ERROR");
  await expectErrorCode(getMeetingTimeline(actor(viewer), { ...query, rangeEnd: atHour(19).toISOString() }), "VALIDATION_ERROR");
  await expectErrorCode(getMeetingTimeline(actor(viewer), { kind: "PREVIEW", personIds: input.personIds, rangeStart: input.rangeStart, rangeEnd: input.rangeEnd }), "FORBIDDEN");
});

test("会议列表按稳定游标分页且搜索不携带纪要", async () => {
  const { admin, input } = await fixture();
  const prefix = `会议分页 ${randomUUID()}`;
  await prisma.meetingRecord.createMany({ data: Array.from({ length: 27 }, (_, index) => ({
    id: randomUUID(), topic: `${prefix} ${index}`, rangeStart: input.rangeStart, rangeEnd: input.rangeEnd,
    createdByAccountId: admin.account.id, updatedAt: new Date(), minutes: "列表不返回正文",
  })) });
  const first = await listMeetings({ query: prefix });
  expect(first.items).toHaveLength(25);
  expect(first.items[0]).not.toHaveProperty("minutes");
  const second = await listMeetings({ query: prefix, cursor: first.nextCursor });
  expect(second.items).toHaveLength(2);
  expect(new Set([...first.items, ...second.items].map((meeting) => meeting.id)).size).toBe(27);
  expect(second.nextCursor).toBeNull();
});

test("超量工作记录明确报错而非截断，可缩小查看范围恢复", async () => {
  const { admin, viewer, participant, input } = await fixture();
  const meeting = await createMeeting(actor(admin), input);
  await prisma.workSegment.createMany({ data: Array.from({ length: 5001 }, () => ({
    personId: participant.person.id, createdByAccountId: participant.account.id, updatedByAccountId: participant.account.id,
    startAt: atHour(9), endAt: atHour(10), content: "会议容量边界记录",
  })) });
  const query = { kind: "SAVED", meetingId: meeting.id, rangeStart: input.rangeStart, rangeEnd: input.rangeEnd };
  await expectErrorCode(getMeetingTimeline(actor(viewer), query), "QUERY_LIMIT_EXCEEDED");
  const narrower = await getMeetingTimeline(actor(viewer), { ...query, rangeStart: atHour(10).toISOString() });
  expect(narrower.rows).toHaveLength(1);
  expect(narrower.segments).toHaveLength(0);
});

test("会议投入提醒校验权限、区间、幂等和投递记录", async () => {
  const { admin, viewer, participant, input } = await fixture();
  const meeting = await createMeeting(actor(admin), input);
  const query = { meetingId: meeting.id };
  await expectErrorCode(listMeetingMissingPeople(actor(viewer), query), "FORBIDDEN");
  expect((await listMeetingMissingPeople(actor(participant), query)).participants[0].missing).toBe(true);
  await createSegment({ accountId: participant.account.id, personId: participant.person.id, startAt: atHour(7), endAt: atHour(8), content: "边界外" });
  expect((await listMeetingMissingPeople(actor(participant), query)).participants[0].missing).toBe(true);
  const segment = await createSegment({ accountId: participant.account.id, personId: participant.person.id, startAt: atHour(8), endAt: atHour(9), content: "本次投入" });
  expect((await listMeetingMissingPeople(actor(participant), query)).participants[0].missing).toBe(false);
  await prisma.workSegment.update({ where: { id: segment.id }, data: { deletedAt: new Date() } });
  expect((await listMeetingMissingPeople(actor(participant), query)).participants[0].missing).toBe(true);
  const send = { ...query, expectedVersion: meeting.version, requestId: randomUUID(), recipientPersonIds: [participant.person.id] };
  await expectErrorCode(urgeMeetingWorkSegments(actor(viewer), send), "FORBIDDEN");
  await expectErrorCode(urgeMeetingWorkSegments(actor(participant), { ...send, recipientPersonIds: [viewer.person.id] }), "FORBIDDEN");
  const results = await Promise.all([urgeMeetingWorkSegments(actor(participant), send), urgeMeetingWorkSegments(actor(participant), send)]);
  expect(results.map((result) => result.recipientCount)).toEqual([1, 1]);
  expect(await prisma.domainAuditEvent.count({ where: { entityId: meeting.id, action: "pm.meeting.work_segment_reminder" } })).toBe(1);
  const outboxes = await prisma.notificationOutbox.findMany({ where: { type: "meeting_work_segment_reminder", payload: { contains: meeting.id } } });
  expect(outboxes).toHaveLength(1);
  expect(outboxes[0].botKind).toBe("notification");
  const payload = JSON.parse(outboxes[0].payload);
  expect(payload.summary).toContain(meeting.topic);
  expect(payload.summary).toContain("北京时间");
  expect(payload.recipientOpenIds).toEqual([participant.openId]);
  expect(await prisma.inAppNotification.count({ where: { entityId: meeting.id, recipientAccountId: participant.account.id } })).toBe(1);
  await urgeMeetingWorkSegments(actor(participant), { ...send, requestId: randomUUID() });
  expect(await prisma.inAppNotification.count({ where: { entityId: meeting.id } })).toBe(2);
  await prisma.person.update({ where: { id: participant.person.id }, data: { status: "INACTIVE" } });
  await expectErrorCode(urgeMeetingWorkSegments(actor(participant), { ...send, requestId: randomUUID() }), "FORBIDDEN");
});
