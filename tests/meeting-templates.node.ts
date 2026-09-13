import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { copyMeetingTemplateContent, meetingTemplateFieldsSchema } from "../lib/project-management/meetings/template-validation";

test("模板严格排除时间并沿用会议字段约束", () => {
  const fields = { name: "周会", topic: "进展", personIds: [randomUUID()], minutes: "", timelineDisplay: { projectIds: [], taskIds: [] } };
  assert.equal(meetingTemplateFieldsSchema.safeParse(fields).success, true);
  for (const extra of [{ rangeStart: "2026-09-01T00:00:00Z" }, { rangeEnd: "2026-09-08T00:00:00Z" }, { repeat: "weekly" }]) {
    assert.equal(meetingTemplateFieldsSchema.safeParse({ ...fields, ...extra }).success, false);
  }
  for (const invalid of [{ name: " " }, { name: "模".repeat(101) }, { description: "说".repeat(501) }, { topic: "" }, { personIds: [] }, { minutes: "字".repeat(50001) }]) {
    assert.equal(meetingTemplateFieldsSchema.safeParse({ ...fields, ...invalid }).success, false);
  }
});

test("实例化只复制非时间内容且不存在数组引用共享", () => {
  const source = { name: "不会进入会议", topic: "周会", minutes: "", personIds: [randomUUID()], timelineDisplay: { projectIds: [randomUUID()], taskIds: [randomUUID()] }, rangeStart: "不复制时间" };
  const copy = copyMeetingTemplateContent(source);
  assert.deepEqual(Object.keys(copy).sort(), ["topic", "minutes", "personIds", "timelineDisplay"].sort());
  copy.personIds.length = 0;
  copy.timelineDisplay.projectIds.length = 0;
  copy.timelineDisplay.taskIds.length = 0;
  copy.topic = "独立内容";
  assert.equal(source.personIds.length, 1);
  assert.equal(source.timelineDisplay.projectIds.length, 1);
  assert.equal(source.timelineDisplay.taskIds.length, 1);
  assert.equal(source.topic, "周会");
});
