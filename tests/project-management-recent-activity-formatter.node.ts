import assert from "node:assert/strict";
import test from "node:test";
import {
  actionsForActivityFilter,
  formatRecentActivityAuditEvent,
  RECENT_ACTIVITY_ACTIONS,
} from "../lib/project-management/recent-activity-formatter";

const internalUuid = "b526bba2-5ca0-47a3-9cd8-bd50ca0eb78e";
const internalHash = "8f14e45fceea167a5a36dedd4bea2543";

test("全部近期动态白名单 action 都生成用户可读的中文 DTO", () => {
  assert.ok(RECENT_ACTIVITY_ACTIONS.length > 0);

  for (const action of RECENT_ACTIVITY_ACTIONS) {
    const item = formatRecentActivityAuditEvent({
      id: `audit-${action}`,
      action,
      before: {
        status: "DRAFT",
        priority: "LOW",
        members: [{ personId: internalUuid }],
        tagIds: [internalUuid],
        descriptionHash: internalHash,
        lockVersion: 17,
      },
      after: {
        status: "ACTIVE",
        priority: "HIGH",
        members: [{ personId: internalUuid }, { personId: "second-person" }],
        tagIds: [internalUuid, "second-tag"],
        descriptionHash: internalHash,
        lockVersion: 18,
      },
      reason: "",
      createdAt: new Date("2026-08-07T04:00:00.000Z"),
      projectId: "project-safe-link-id",
      taskId: null,
      project: { id: "project-safe-link-id", name: "协作功能 Project" },
      task: null,
      actorPerson: { displayName: "测试操作人" },
    });

    assert.ok(item, `${action} 应生成近期动态`);
    assert.match(item.title, /[\p{Script=Han}]/u);
    assert.match(item.summary, /[\p{Script=Han}]/u);
    assert.equal(item.createdAt, "2026-08-07T04:00:00.000Z");

    const visibleText = [
      item.title,
      item.summary,
      item.actorName,
      item.targetName,
    ].join(" ");
    assert.doesNotMatch(visibleText, new RegExp(internalUuid, "u"));
    assert.doesNotMatch(visibleText, new RegExp(internalHash, "u"));
    assert.doesNotMatch(
      visibleText,
      /before|after|descriptionHash|lockVersion|personId|tagIds/u,
    );
  }
});

test("未知 action 不进入近期动态", () => {
  const item = formatRecentActivityAuditEvent({
    id: "unknown-audit",
    action: "pm.internal.unknown",
    before: null,
    after: { lockVersion: 1 },
    reason: "",
    createdAt: new Date("2026-08-07T04:00:00.000Z"),
    projectId: null,
    taskId: null,
    project: null,
    task: null,
    actorPerson: null,
  });

  assert.equal(item, null);
});

test("系统事件和过长用户文本使用安全中文摘要", () => {
  const longContent = "风险说明".repeat(80);
  const item = formatRecentActivityAuditEvent({
    id: "system-risk-audit",
    action: "pm.task.risk.create",
    before: null,
    after: { content: longContent },
    reason: "",
    createdAt: new Date("2026-08-07T04:00:00.000Z"),
    projectId: null,
    taskId: null,
    project: null,
    task: null,
    actorPerson: null,
  });

  assert.ok(item);
  assert.equal(item.actorName, "系统");
  assert.equal(item.targetName, "风险");
  assert.match(item.summary, /^内容：/u);
  assert.match(item.summary, /…$/u);
  assert.ok(item.summary.length <= 164);
});

test("动态筛选在服务端 action 白名单上生效", () => {
  const projectActions = actionsForActivityFilter("PROJECT", "PROJECT");
  const projectTaskActions = actionsForActivityFilter("PROJECT", "TASK");
  const taskActions = actionsForActivityFilter("TASK", "ALL");

  assert.ok(projectActions.length > 0);
  assert.ok(projectActions.every((action) => action.startsWith("pm.project.")));
  assert.ok(projectTaskActions.includes("pm.task.metadata.update"));
  assert.ok(projectTaskActions.includes("pm.revision.create"));
  assert.ok(taskActions.includes("pm.task.risk.create"));
  assert.ok(!taskActions.includes("pm.project.metadata.update"));
});

test("嵌套草稿变更只输出字段级摘要和已装配的可读目标名", () => {
  const item = formatRecentActivityAuditEvent({
    id: "draft-update-audit",
    action: "pm.task.draft.update",
    before: {
      metadata: { title: "旧标题", priority: "LOW" },
      plan: { nodeCount: 2, snapshotHash: internalHash },
    },
    after: {
      metadata: { title: "新标题", priority: "UNKNOWN_INTERNAL_PRIORITY" },
      plan: { nodeCount: 4, snapshotHash: internalHash },
      planChanges: {
        added: { totalCount: 2, entries: [{ nodeId: internalUuid }] },
      },
    },
    reason: "",
    createdAt: new Date("2026-08-07T04:00:00.000Z"),
    projectId: null,
    taskId: "task-link-id",
    project: null,
    task: { id: "task-link-id", title: "所属 Task" },
    actorPerson: { displayName: "测试操作人" },
    entityName: "Revision：调整验收计划",
  });

  assert.ok(item);
  assert.equal(item.targetName, "Revision：调整验收计划");
  assert.match(item.summary, /名称：旧标题 → 新标题/u);
  assert.match(item.summary, /优先级：低 → 其他优先级/u);
  assert.match(item.summary, /计划节点数量：2 → 4/u);
  assert.match(item.summary, /计划节点：新增 2/u);
  assert.doesNotMatch(item.summary, /UNKNOWN_INTERNAL_PRIORITY/u);
  assert.doesNotMatch(item.summary, new RegExp(internalHash, "u"));
  assert.doesNotMatch(item.summary, new RegExp(internalUuid, "u"));
});
