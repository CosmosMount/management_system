// @playwright-project node-db
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createMeeting, getMeeting, updateMeeting } from "../lib/project-management/meetings/service";
import { createMeetingTemplate, deleteMeetingTemplate, getMeetingTemplate, listMeetingTemplates, updateMeetingTemplate } from "../lib/project-management/meetings/template-service";
import { copyMeetingTemplateContent } from "../lib/project-management/meetings/template-validation";
import { actor, createAccountPerson, createTask, expectErrorCode } from "./helpers/project-management-canvas-security-fixtures";

async function fixture() {
  const admin = await createAccountPerson(`模板超管 ${randomUUID()}`);
  const second = await createAccountPerson(`模板另一超管 ${randomUUID()}`);
  const viewer = await createAccountPerson(`模板查看者 ${randomUUID()}`);
  await prisma.systemRoleAssignment.createMany({ data: [admin, second].map(({ account }) => ({ accountId: account.id, role: "SUPER_ADMINISTRATOR" as const, team: "", techGroup: "" })) });
  const input = { requestId: randomUUID(), name: "每周组会模板", description: "同步进展", topic: "组会", personIds: [viewer.person.id], minutes: "# 议程\n## 下周计划", timelineDisplay: { projectIds: [] as string[], taskIds: [] as string[] } };
  return { admin, second, viewer, input };
}

test("模板共享管理、幂等、独立实例化与删除审计均不发送通知", async () => {
  const { admin, second, viewer, input } = await fixture();
  const project = await prisma.project.create({ data: { name: "模板展示项目", description: "", requesterAccountId: admin.account.id } });
  const task = await createTask({ ownerAccountId: admin.account.id, title: "模板展示任务", team: "英雄", techGroup: "电控", members: [{ personId: admin.person.id, role: "OWNER" }] });
  input.timelineDisplay = { projectIds: [project.id], taskIds: [task.taskId] };
  const [template, retry] = await Promise.all([createMeetingTemplate(actor(admin), input), createMeetingTemplate(actor(admin), input)]);
  expect(retry).toEqual(template);
  await expectErrorCode(createMeetingTemplate(actor(admin), { ...input, topic: "不同请求内容" }), "DUPLICATE_OPERATION");
  expect((await getMeetingTemplate(actor(second), { templateId: template.id })).template).toEqual(template);
  const selection = await getMeetingTemplate(actor(admin), { templateId: template.id });
  expect(selection.fieldErrors).toEqual({});
  const draft = copyMeetingTemplateContent(selection.template);
  const meeting = await createMeeting(actor(admin), { ...draft, requestId: randomUUID(), rangeStart: "2026-09-01T00:00:00Z", rangeEnd: "2026-09-08T00:00:00Z" });
  expect(meeting.timelineDisplay).toEqual(template.timelineDisplay);
  const changed = await updateMeetingTemplate(actor(second), { ...copyMeetingTemplateContent(template), name: "其他超管修改", description: template.description, templateId: template.id, expectedVersion: 0 });
  expect(changed.version).toBe(1);
  await updateMeeting(actor(admin), { ...draft, meetingId: meeting.id, expectedVersion: 0, topic: "自由修改的会议", minutes: "会议独立纪要", rangeStart: meeting.rangeStart, rangeEnd: meeting.rangeEnd });
  expect((await getMeetingTemplate(actor(admin), { templateId: template.id })).template.minutes).toBe(template.minutes);
  await deleteMeetingTemplate(actor(second), { templateId: template.id, expectedVersion: 1 });
  await expectErrorCode(getMeetingTemplate(actor(admin), { templateId: template.id }), "NOT_FOUND");
  expect((await listMeetingTemplates(actor(admin))).items.some((item) => item.id === template.id)).toBe(false);
  expect((await getMeeting({ meetingId: meeting.id })).topic).toBe("自由修改的会议");
  const fromOldDraft = await createMeeting(actor(admin), { ...draft, requestId: randomUUID(), rangeStart: meeting.rangeStart, rangeEnd: meeting.rangeEnd });
  expect(fromOldDraft.minutes).toBe(template.minutes);
  expect(await prisma.meetingTemplateParticipant.count({ where: { templateId: template.id } })).toBe(1);
  expect(await prisma.domainAuditEvent.count({ where: { entityId: template.id } })).toBe(3);
  expect(await prisma.notificationOutbox.count({ where: { payload: { contains: template.id } } })).toBe(0);
  await expectErrorCode(createMeetingTemplate(actor(viewer), { ...input, requestId: randomUUID() }), "FORBIDDEN");
});

test("模板服务拒绝普通用户、伪造角色及过期身份", async () => {
  const { admin, viewer, input } = await fixture();
  const template = await createMeetingTemplate(actor(admin), input);
  const fields = { ...copyMeetingTemplateContent(input), name: input.name, description: input.description };
  const forged = { ...actor(viewer), systemRoles: [{ role: "SUPER_ADMINISTRATOR" as const, team: "", techGroup: "" }] };
  for (const identity of [actor(viewer), forged]) {
    await expectErrorCode(listMeetingTemplates(identity), "FORBIDDEN");
    await expectErrorCode(getMeetingTemplate(identity, { templateId: template.id }), "FORBIDDEN");
    await expectErrorCode(createMeetingTemplate(identity, { ...input, requestId: randomUUID() }), "FORBIDDEN");
    await expectErrorCode(updateMeetingTemplate(identity, { ...fields, templateId: template.id, expectedVersion: 0 }), "FORBIDDEN");
    await expectErrorCode(deleteMeetingTemplate(identity, { templateId: template.id, expectedVersion: 0 }), "FORBIDDEN");
  }
  await prisma.person.update({ where: { id: admin.person.id }, data: { status: "INACTIVE" } });
  await expectErrorCode(getMeetingTemplate(actor(admin), { templateId: template.id }), "FORBIDDEN");
});

test("模板更新和删除发生并发时只允许一个版本提交", async () => {
  const { admin, second, input } = await fixture();
  const template = await createMeetingTemplate(actor(admin), input);
  const fields = { ...copyMeetingTemplateContent(input), name: input.name, description: input.description };
  const results = await Promise.allSettled([
    updateMeetingTemplate(actor(admin), { ...fields, name: "修改后的模板", templateId: template.id, expectedVersion: 0 }),
    deleteMeetingTemplate(actor(second), { templateId: template.id, expectedVersion: 0 }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await prisma.domainAuditEvent.count({ where: { entityId: template.id } })).toBe(2);
  expect((await prisma.meetingTemplate.findUniqueOrThrow({ where: { id: template.id } })).version).toBe(1);
});

test("模板失效引用明确返回字段错误且保存必须修正", async () => {
  const { admin, viewer, input } = await fixture();
  const project = await prisma.project.create({ data: { name: "即将删除项目", description: "", requesterAccountId: admin.account.id } });
  const template = await createMeetingTemplate(actor(admin), { ...input, timelineDisplay: { projectIds: [project.id], taskIds: [] } });
  await prisma.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });
  await prisma.person.update({ where: { id: viewer.person.id }, data: { status: "INACTIVE" } });
  const selection = await getMeetingTemplate(actor(admin), { templateId: template.id });
  expect(selection.fieldErrors.personIds).toBeDefined();
  expect(selection.fieldErrors["timelineDisplay.projectIds"]).toBeDefined();
  expect(selection.template.timelineDisplay.projectIds).toEqual([project.id]);
  await expectErrorCode(createMeeting(actor(admin), { ...copyMeetingTemplateContent(selection.template), requestId: randomUUID(), rangeStart: "2026-09-01T00:00:00Z", rangeEnd: "2026-09-08T00:00:00Z" }), "VALIDATION_ERROR");
  const fields = { ...copyMeetingTemplateContent(input), name: input.name, description: input.description };
  await expectErrorCode(updateMeetingTemplate(actor(admin), { ...fields, templateId: template.id, expectedVersion: 0 }), "VALIDATION_ERROR");
  const repaired = await updateMeetingTemplate(actor(admin), { ...fields, personIds: [admin.person.id], templateId: template.id, expectedVersion: 0 });
  expect(repaired.personIds).toEqual([admin.person.id]);
});

test("模板列表使用独立游标分页并拒绝非法参数", async () => {
  const { admin, input } = await fixture();
  const ids: string[] = [];
  for (let index = 0; index < 12; index++) ids.push((await createMeetingTemplate(actor(admin), { ...input, requestId: randomUUID(), name: `分页模板 ${index}` })).id);
  const first = await listMeetingTemplates(actor(admin));
  expect(first.items).toHaveLength(10);
  expect(first.nextCursor).not.toBeNull();
  const next = await listMeetingTemplates(actor(admin), { cursor: first.nextCursor });
  expect(next.items.every((item) => !first.items.some((prior) => prior.id === item.id))).toBe(true);
  expect([...first.items, ...next.items].filter((item) => ids.includes(item.id))).toHaveLength(12);
  await expect(listMeetingTemplates(actor(admin), { cursor: { id: "bad", updatedAt: "bad" } })).rejects.toThrow();
});
