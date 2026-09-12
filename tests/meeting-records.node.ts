import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { canManageMeetings } from "../lib/project-management/meetings/permissions";
import { meetingFieldsSchema, meetingTimelineSchema, meetingTimelineDisplaySchema } from "../lib/project-management/meetings/validation";
import { shanghaiDateTimeLocalToIso } from "../lib/project-management/date-time";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import { resolveContentNavigationWindow } from "../lib/project-management/time-canvas/content-window";

const fields = {
  topic: "透明会议", personIds: [randomUUID()], minutes: "",
  rangeStart: "2026-09-01T00:00:00.000Z", rangeEnd: "2026-09-02T00:00:00.000Z",
};

test("会议只允许在职全局超管维护，不把项目管理员当作超管", () => {
  const actor: ProjectManagementActor = { accountId: randomUUID(), personId: randomUUID(), openId: "test", systemRoles: [] };
  assert.equal(canManageMeetings(actor), false);
  assert.equal(canManageMeetings({ ...actor, systemRoles: [{ role: "PROJECT_ADMINISTRATOR", team: "", techGroup: "" }] }), false);
  const admin: ProjectManagementActor = { ...actor, systemRoles: [{ role: "SUPER_ADMINISTRATOR", team: "", techGroup: "" }] };
  assert.equal(canManageMeetings(admin), true);
  assert.equal(canManageMeetings({ ...admin, isActive: false }), false);
  assert.equal(canManageMeetings({ ...actor, systemRoles: [{ role: "SUPER_ADMINISTRATOR", team: "英雄", techGroup: "" }] }), false);
});

test("会议校验必填字段、重复参与人、时间边界及不接受项目归属", () => {
  assert.equal(meetingFieldsSchema.safeParse(fields).success, true);
  for (const invalid of [
    { topic: "  " }, { topic: "会".repeat(201) }, { personIds: [] },
    { personIds: [...fields.personIds, ...fields.personIds] },
    { rangeEnd: fields.rangeStart }, { rangeEnd: "2028-01-01T00:00:00Z" },
    { rangeStart: "2026-09-01T08:00" }, { minutes: "字".repeat(50_001) }, { projectId: randomUUID() },
  ]) assert.equal(meetingFieldsSchema.safeParse({ ...fields, ...invalid }).success, false);
  assert.equal(shanghaiDateTimeLocalToIso("2026-09-01T08:00"), fields.rangeStart);
});

test("已保存会议时间线输入不接受伪造人员范围", () => {
  const saved = { kind: "SAVED", meetingId: randomUUID(), rangeStart: fields.rangeStart, rangeEnd: fields.rangeEnd };
  assert.equal(meetingTimelineSchema.safeParse(saved).success, true);
  assert.equal(meetingTimelineSchema.safeParse({ ...saved, personIds: fields.personIds }).success, false);
  assert.equal(meetingTimelineSchema.safeParse({ ...saved, timelineDisplay: { projectIds: [], taskIds: [] } }).success, false);
});

test("会议展示配置规范化、数量上限和非法标识", () => {
  const projectId = randomUUID();
  assert.deepEqual(meetingTimelineDisplaySchema.parse({ projectIds: [projectId, projectId], taskIds: [] }), { projectIds: [projectId], taskIds: [] });
  for (const config of [{ projectIds: ["invalid"], taskIds: [] }, { projectIds: [], taskIds: Array.from({ length: 51 }, () => randomUUID()) }, { projectIds: [], taskIds: [], projectId }]) {
    assert.equal(meetingTimelineDisplaySchema.safeParse(config).success, false);
  }
});

test("会议和工作台共用日历范围，保留历史内容、今天和跨年导航", () => {
  const now = Date.parse("2026-09-12T00:00:00Z");
  const contentRange = { startMs: Date.parse("2020-01-01T00:00:00Z"), endMs: Date.parse("2035-06-01T00:00:00Z") };
  const result = resolveContentNavigationWindow({ contentRange, businessContentRange: contentRange, preferredCenterMs: now, now });
  assert.equal(result.rangeClipped, true);
  assert.ok(result.fullRange.startMs < contentRange.startMs);
  assert.ok(result.fullRange.endMs > contentRange.endMs);
  assert.ok(result.range.startMs <= now && result.range.endMs > now);
  assert.equal(result.resolvedCenterMs, now);
  const historical = { startMs: contentRange.startMs, endMs: contentRange.startMs + 3600000 };
  const fallback = resolveContentNavigationWindow({ contentRange: historical, businessContentRange: historical, now });
  assert.equal(fallback.resolvedCenterMs, historical.startMs);
  assert.ok(fallback.fullRange.endMs > now);
});
