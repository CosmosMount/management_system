import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { canManageMeetings } from "../lib/project-management/meetings/permissions";
import { meetingFieldsSchema, meetingTimelineSchema, meetingTimelineDisplaySchema, listMeetingsSchema, meetingPeopleFilterSchema } from "../lib/project-management/meetings/validation";
import { shanghaiDateTimeLocalToIso } from "../lib/project-management/date-time";
import type { ProjectManagementActor } from "../lib/project-management/identity";
import { resolveContentNavigationWindow } from "../lib/project-management/time-canvas/content-window";
import { formatMeetingMinutes, type MeetingMinutesSource } from "../lib/project-management/meetings/markdown";

test("会议导出模板保留结构、绝对链接、北京时间及安全的多行列表", () => {
  const source: MeetingMinutesSource = {
    id: randomUUID(), topic: "周会 [讨论]", rangeStart: "2026-08-10T00:00:00Z", rangeEnd: "2026-08-11T00:00:00Z", minutes: "原有纪要\n第二行",
    participants: [{ id: "person", displayName: "张*三", status: "ACTIVE" }, { id: "empty", displayName: "李四", status: "INACTIVE" }],
    tasks: [{ id: randomUUID(), title: "任务 [一]", project: { id: randomUUID(), name: "项目 / 一" } }, { id: randomUUID(), title: "独立任务", project: null }],
    segments: [{ personId: "person", content: "第一行\n# 第二行", task: null }],
  };
  const markdown = formatMeetingMinutes(source);
  assert.ok(markdown.startsWith("# 周会 \\[讨论\\]"));
  assert.ok(markdown.includes("2026/08/10 08:00 至 2026/08/11 08:00（工作区间，北京时间）"));
  for (const heading of ["## 进度汇报", "### 进行中的任务", "### 个人进度汇报", "其他：", "## 下周安排"]) assert.ok(markdown.includes(heading));
  assert.ok(markdown.includes(`/progress/projects/${source.tasks[0].project?.id})/[任务 \\[一\\]](`));
  assert.ok(markdown.includes(`/progress/tasks/${source.tasks[1].id})`));
  assert.match(markdown, /\[系统中的会议链接\]\(https?:\/\//);
  assert.ok(markdown.includes("* 张\\*三：\n    * 第一行\n      \\# 第二行"));
  assert.ok(markdown.includes("* 李四（已停用）：\n    * 本工作区间暂无投入记录"));
  assert.ok(markdown.includes("其他：\n\n原有纪要\n第二行"));
  assert.ok(markdown.includes("## 下周安排\n\n* 张\\*三\n    * 待补充"));
  const empty = formatMeetingMinutes({ ...source, tasks: [], participants: [], segments: [], minutes: "" }, "https://untrusted.invalid");
  assert.ok(empty.includes("暂无进行中的任务"));
  assert.ok(empty.includes("暂无参与人员"));
  assert.ok(empty.includes("其他：\n\n待补充"));
  assert.ok(!empty.includes("untrusted.invalid"));
});

const fields = {
  topic: "透明会议", personIds: [randomUUID()], minutes: "",
  rangeStart: "2026-09-01T00:00:00.000Z", rangeEnd: "2026-09-02T00:00:00.000Z",
};

test("会议组合筛选校验日期、标识、枚举和拒绝伪造创建人", () => {
  assert.equal(listMeetingsSchema.parse({}).sort, "createdAt");
  assert.equal(listMeetingsSchema.safeParse({ personId: randomUUID(), period: "custom", dateFrom: "2026-09-01", dateTo: "2026-09-01", projectId: "none", taskId: randomUUID(), mine: true, sort: "updatedAt" }).success, true);
  for (const invalid of [
    { personId: "" }, { personId: "invalid" }, { projectId: "invalid" }, { taskId: "invalid" },
    { dateFrom: "2026-02-30" }, { dateTo: "2026-09-01T00:00:00Z" },
    { dateFrom: "2026-09-02", dateTo: "2026-09-01" }, { sort: "topic" }, { period: "15" },
    { mine: "true" }, { createdByAccountId: randomUUID() }, { cursor: "bad" },
    { period: "custom" }, { period: "7", dateFrom: "2026-09-01" },
  ]) assert.equal(listMeetingsSchema.safeParse(invalid).success, false);
  assert.equal(meetingPeopleFilterSchema.safeParse({ ids: Array.from({ length: 51 }, () => randomUUID()) }).success, false);
});

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
