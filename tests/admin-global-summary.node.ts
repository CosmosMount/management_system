import assert from "node:assert/strict";
import test from "node:test";
import { adminSummaryNotificationPreview, buildAdminSummaryMarkdown, summaryCell, type AdminSummaryRow } from "../lib/project-management/admin-summary-markdown";
import {
  botKindForPayload,
  isProjectManagementApprovalRequestKind,
  projectManagementNotificationPayloadSchema,
} from "../lib/project-management/notifications/contract";

const payload = {
  kind: "project_management_global_summary_daily",
  payloadVersion: 1,
  purpose: "notification",
  category: "PROJECT",
  title: "管理员全局进度总结",
  summary: "管理员已手动执行全局进度总结，生成成功。",
  actorName: "总结测试管理员",
  entityType: "AdminGlobalSummaryRun",
  entityId: "00000000-0000-4000-8000-000000000001",
  linkPath: "/progress/notifications?view=settings",
  recipientOpenIds: ["ou_summary_test_admin"],
};

test("大总结只发送有限摘要，保留完整行并明确完整内容入口", () => {
  const short = "# 总结\n\n当前无待处理事项。";
  assert.equal(adminSummaryNotificationPreview(short), short);
  const table = "# 总结\n| 项目 | Task |\n| --- | --- |\n" + "| 项目 | 待办任务 |\n".repeat(10_000);
  const preview = adminSummaryNotificationPreview(table);
  assert.ok(preview.length <= 6000);
  assert.ok(preview.includes("未展示全部节点"));
  assert.ok(preview.includes("查看完整 Markdown 总结"));
  assert.ok(preview.split("\n").filter((line) => line.startsWith("|")).every((line) => line.endsWith("|")));
});

test("管理员全局总结属于通知机器人事件，保留操作人与业务上下文", () => {
  const result = projectManagementNotificationPayloadSchema.parse(payload);
  assert.equal(result.kind, "project_management_global_summary_daily");
  assert.equal(botKindForPayload(result), "notification");
  assert.equal(isProjectManagementApprovalRequestKind(result.kind), false);
  assert.equal(result.actorName, payload.actorName);
  assert.equal(result.summary, payload.summary);
  assert.equal(result.entityId, payload.entityId);
  assert.equal(result.linkPath, payload.linkPath);
  assert.deepEqual(result.recipientOpenIds, payload.recipientOpenIds);
});

test("管理员全局总结不能伪装为审批请求", () => {
  const result = projectManagementNotificationPayloadSchema.safeParse({
    ...payload,
    purpose: "approval_request",
  });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((issue) => issue.path.includes("purpose")));
  }
});

test("管理员全局总结拒绝错误版本及损坏收件人契约", () => {
  for (const invalid of [
    { ...payload, payloadVersion: 2 },
    { ...payload, recipientOpenIds: "ou_summary_test_admin" },
    { ...payload, entityId: "" },
  ]) {
    assert.equal(projectManagementNotificationPayloadSchema.safeParse(invalid).success, false);
  }
});

test("总结空态保留生成时间和零计数", () => {
  const markdown = buildAdminSummaryMarkdown([], "2026/9/13 09:00", 0);
  assert.match(markdown, /管理员全局进度总结/);
  assert.match(markdown, /2026\/9\/13 09:00/);
  assert.match(markdown, /项目：0.*待推进任务：0.*逾期任务：0.*待审批：0/);
  assert.match(markdown, /当前无待处理事项/);
});

test("总结按标识去重计数，同名项目任务不合并且未关联项目不计入项目数", () => {
  const row: AdminSummaryRow = {
    projectId: "project-one", taskId: "task-one", project: "同名项目", task: "同名任务",
    status: "进行中", owners: "负责人", node: "节点一", plannedStart: "2026/9/12 09:00",
    deadline: "2026/9/13 09:00", approvals: "里程碑验收", risk: "节点逾期",
  };
  const markdown = buildAdminSummaryMarkdown([
    row,
    { ...row, node: "节点二" },
    { ...row, projectId: "project-two", taskId: "task-two", risk: "无" },
    { ...row, projectId: null, taskId: "task-three", project: "未关联项目", risk: "无" },
  ], "2026/9/13 09:00", 2);
  assert.match(markdown, /项目：2.*待推进任务：3.*逾期任务：1.*待审批：2/);
  assert.match(markdown, /节点一/);
  assert.match(markdown, /节点二/);
  assert.match(markdown, /未关联项目/);
});

test("总结单元格转义全员提及、表格分隔符、反引号和换行", () => {
  assert.equal(summaryCell("<at id=all>所有人</at>|`名称`\r\n下一行 &"),
    "&lt;at id=all&gt;所有人&lt;/at&gt;&#124;&#96;名称&#96; 下一行 &amp;");
  const unsafe = "<at id=all>所有人</at>|`名称`\n下一行";
  const markdown = buildAdminSummaryMarkdown([{
    project: unsafe, task: unsafe, status: unsafe, owners: unsafe, node: unsafe,
    plannedStart: unsafe, deadline: unsafe, approvals: unsafe, risk: unsafe,
  }], "2026/9/13 09:00", 0);
  assert.ok(!markdown.includes("<at"));
  assert.ok(!markdown.includes("`"));
  assert.equal(markdown.split("\n").filter((line) => line.startsWith("| ")).length, 3);
});
