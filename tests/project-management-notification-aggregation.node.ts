import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildProjectManagementAggregatedCard } from "../lib/project-management/notifications/aggregation-card";
import {
  isProjectManagementNotificationAggregationEligible,
  projectManagementNotificationAggregationWindowSeconds,
} from "../lib/project-management/notifications/aggregation";
import type { ProjectManagementNotificationPayload } from "../lib/project-management/notifications/contract";

const ENV_KEY =
  "PROJECT_MANAGEMENT_NOTIFICATION_AGGREGATION_WINDOW_SECONDS";
const originalWindow = process.env[ENV_KEY];

afterEach(() => {
  if (originalWindow === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalWindow;
});

test("项目管理通知聚合窗口默认 30 秒、允许关闭并拒绝越界配置", () => {
  delete process.env[ENV_KEY];
  assert.equal(projectManagementNotificationAggregationWindowSeconds(), 30);
  process.env[ENV_KEY] = "0";
  assert.equal(projectManagementNotificationAggregationWindowSeconds(), 0);
  process.env[ENV_KEY] = "300";
  assert.equal(projectManagementNotificationAggregationWindowSeconds(), 300);
  for (const invalid of ["-1", "301", "1.5", "abc"]) {
    process.env[ENV_KEY] = invalid;
    assert.throws(
      () => projectManagementNotificationAggregationWindowSeconds(),
      /必须是 0-300 的整数/,
    );
  }
});

test("只有非强制、非审批、非每日总结的项目普通通知允许聚合", () => {
  assert.equal(
    isProjectManagementNotificationAggregationEligible(payload()),
    true,
  );
  assert.equal(
    isProjectManagementNotificationAggregationEligible(
      payload({ mandatory: true }),
    ),
    false,
  );
  assert.equal(
    isProjectManagementNotificationAggregationEligible(
      payload({
        kind: "milestone_review_submitted",
        purpose: "approval_request",
        category: "REVIEW",
      }),
    ),
    false,
  );
  assert.equal(
    isProjectManagementNotificationAggregationEligible(
      payload({ kind: "project_management_personal_summary_daily" }),
    ),
    false,
  );
});

test("聚合卡片最多展示十条纯文本明细并提示溢出", () => {
  const card = buildProjectManagementAggregatedCard(
    Array.from({ length: 11 }, (_, index) => ({
      payload: payload({
        title: `标题 ${index + 1} [恶意](https://example.invalid)`,
        summary: `摘要 ${index + 1}`,
        entityId: `task-${index + 1}`,
        taskId: `task-${index + 1}`,
        taskTitle: `任务 ${index + 1}`,
      }),
      createdAt: new Date(`2026-09-16T00:${String(index).padStart(2, "0")}:00.000Z`),
    })),
    "TASK",
  );
  const elements = card.elements as unknown as Array<{
      tag: string;
      text?: { tag: string; content: string };
      actions?: Array<{ url: string }>;
    }>;
  assert.equal(card.header.title.content, "任务通知汇总（11 条）");
  assert.equal(
    elements.filter((element) =>
      element.text?.content.match(/^\d+\. /),
    ).length,
    10,
  );
  assert.match(JSON.stringify(card), /另有 1 条通知未在卡片中展开/);
  assert.doesNotMatch(JSON.stringify(card), /摘要 11/);
  assert.ok(
    elements
      .filter((element) => element.tag === "div")
      .every((element) => element.text?.tag === "plain_text"),
  );
  assert.match(
    elements.at(-1)?.actions?.[0]?.url ?? "",
    /\/progress\/notifications$/,
  );

  const longText = "很长的聚合通知内容".repeat(150);
  const boundedCard = buildProjectManagementAggregatedCard(
    Array.from({ length: 10 }, (_, index) => ({
      payload: payload({
        title: longText,
        summary: longText,
        actorName: longText,
        projectName: longText,
        taskTitle: longText,
        entityId: `bounded-${index}`,
        context: {
          content: longText,
          changedFields: longText,
          resolveNote: longText,
        },
      }),
      createdAt: new Date("2026-09-16T00:00:00.000Z"),
    })),
    "TASK",
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(boundedCard), "utf8") <= 20_000,
    "聚合卡片应保留足够的飞书消息体余量",
  );
});

function payload(
  overrides: Partial<ProjectManagementNotificationPayload> = {},
): ProjectManagementNotificationPayload {
  return {
    kind: "task_updated",
    payloadVersion: 1,
    purpose: "notification",
    category: "TASK",
    title: "任务已更新",
    summary: "任务内容发生变化",
    actorName: "测试用户",
    taskId: "task-1",
    taskTitle: "测试任务",
    projectId: null,
    projectName: null,
    entityType: "Task",
    entityId: "task-1",
    linkPath: "/progress/tasks/task-1",
    recipientOpenIds: ["ou_test"],
    mandatory: false,
    appOrigin: "http://127.0.0.1:3002",
    context: {},
    ...overrides,
  };
}
