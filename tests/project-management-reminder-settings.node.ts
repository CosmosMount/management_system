import assert from "node:assert/strict";
import test from "node:test";
import { projectManagementNotificationPayloadSchema } from "../lib/project-management/notifications/contract";

test("提醒通知契约支持任务未激活和审批未完成事件", () => {
  for (const kind of ["task_activation_overdue", "task_approval_pending_daily"] as const) {
    const parsed = projectManagementNotificationPayloadSchema.safeParse({
      kind,
      payloadVersion: 1,
      purpose: "notification",
      category: kind === "task_activation_overdue" ? "TASK" : "REVIEW",
      title: "测试提醒",
      summary: "测试摘要",
      actorName: "系统",
      taskId: "task-1",
      taskTitle: "测试任务",
      entityType: "Task",
      entityId: "task-1",
      linkPath: "/progress/tasks/task-1",
      recipientOpenIds: [],
      mandatory: false,
      context: {},
    });
    assert.equal(parsed.success, true);
  }
});

test("审批请求事件仍然要求审批用途，日常审批提醒使用普通通知用途", () => {
  const parsed = projectManagementNotificationPayloadSchema.safeParse({
    kind: "task_approval_pending_daily",
    payloadVersion: 1,
    purpose: "approval_request",
    category: "REVIEW",
    title: "测试提醒",
    entityType: "Task",
    entityId: "task-1",
  });
  assert.equal(parsed.success, false);
});
