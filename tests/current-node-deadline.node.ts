import assert from "node:assert/strict";
import test from "node:test";
import {
  compareDeadlineTasks,
  DEADLINE_WARNING_MS,
  evaluateDeadline,
  resolveCurrentNodeDeadline,
  type CurrentNodeDeadline,
} from "../lib/project-management/current-node-deadline";

const nowMs = Date.parse("2026-09-09T10:00:00+08:00");
const dueAt = new Date(nowMs).toISOString();
const milestone = {
  id: "milestone", type: "MILESTONE", status: "ACTIVE",
  milestone: { expectedCompletedAt: dueAt },
};
const termination = {
  id: "termination", type: "TERMINATION", status: "ACTIVE",
  termination: { plannedAt: dueAt },
};

function target(offset: number): CurrentNodeDeadline {
  return { nodeId: "milestone", nodeType: "MILESTONE", dueAt: new Date(nowMs + offset).toISOString() };
}

test("节点到期按准确时刻和包含边界的72小时窗口判断", () => {
  for (const [offset, expected] of [
    [-1, "OVERDUE"], [0, "DUE_SOON"], [1, "DUE_SOON"],
    [DEADLINE_WARNING_MS - 1, "DUE_SOON"],
    [DEADLINE_WARNING_MS, "DUE_SOON"],
    [DEADLINE_WARNING_MS + 1, "NOT_DUE"],
  ] as const) assert.equal(evaluateDeadline(target(offset), nowMs), expected);
  assert.equal(evaluateDeadline(null, nowMs), "NONE");
  assert.equal(evaluateDeadline({ ...target(0), dueAt: "invalid" }, nowMs), "NONE");
  assert.equal(evaluateDeadline(target(0), Number.NaN), "NONE");
  assert.equal(evaluateDeadline({ ...target(0), dueAt: "2026-09-09T10:00:00+08:00" }, nowMs), "DUE_SOON");
});

test("当前里程碑优先；只有指针为空才回退结束节点", () => {
  const source = { taskStatus: "ACTIVE", activeMilestoneNodeId: milestone.id, nodes: [termination, milestone] };
  assert.deepEqual(resolveCurrentNodeDeadline(source), target(0));
  assert.deepEqual(resolveCurrentNodeDeadline({ ...source, activeMilestoneNodeId: null }), {
    nodeId: termination.id, nodeType: "TERMINATION", dueAt,
  });
  assert.equal(resolveCurrentNodeDeadline({ ...source, activeMilestoneNodeId: "missing" }), null);
  assert.equal(resolveCurrentNodeDeadline({ ...source, nodes: [termination] }), null);
  assert.equal(resolveCurrentNodeDeadline({ ...source, nodes: [] }), null);
});

test("终态、非激活、历史取消和异常节点不产生当前到期目标", () => {
  const source = { taskStatus: "ACTIVE", activeMilestoneNodeId: milestone.id, nodes: [milestone, termination] };
  for (const taskStatus of ["DRAFT", "COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ARCHIVED"]) {
    assert.equal(resolveCurrentNodeDeadline({ ...source, taskStatus }), null);
  }
  for (const status of ["PENDING", "COMPLETED", "REVISED", "CANCELLED"]) {
    assert.equal(resolveCurrentNodeDeadline({ ...source, nodes: [{ ...milestone, status }, termination] }), null);
  }
  assert.equal(resolveCurrentNodeDeadline({ ...source, nodes: [{ ...milestone, deletedAt: dueAt }] }), null);
  assert.equal(resolveCurrentNodeDeadline({ ...source, nodes: [{ ...milestone, milestone: null }] }), null);
  assert.equal(resolveCurrentNodeDeadline({ ...source, nodes: [{ ...milestone, milestone: { expectedCompletedAt: "invalid" } }] }), null);
  assert.equal(resolveCurrentNodeDeadline({ ...source, nodes: [milestone, milestone] }), null);
  assert.equal(resolveCurrentNodeDeadline({ ...source, activeMilestoneNodeId: null, nodes: [termination, termination] }), null);
  assert.equal(resolveCurrentNodeDeadline({ ...source, nodes: [{ ...milestone, type: "REVISION" }] }), null);
});

test("工作台对全量副本排序后截取预览，风险和日期优先且稳定", () => {
  const tasks = Array.from({ length: 7 }, (_, index) => ({
    id: `task-${index}`, title: `任务${index}`, currentNodeDeadline: target(DEADLINE_WARNING_MS + index + 1),
  }));
  tasks.push({ id: "overdue", title: "最后的紧急任务", currentNodeDeadline: target(-1) });
  const sorted = [...tasks].sort((left, right) => compareDeadlineTasks(left, right, nowMs));
  assert.equal(sorted.slice(0, 6)[0].id, "overdue");
  assert.equal(tasks[0].id, "task-0");
  const same = { title: "相同", currentNodeDeadline: target(0) };
  assert.ok(compareDeadlineTasks({ ...same, id: "a" }, { ...same, id: "b" }, nowMs) < 0);
  assert.ok(compareDeadlineTasks({ ...same, id: "a" }, { ...same, id: "b", currentNodeDeadline: null }, nowMs) < 0);
  assert.equal(evaluateDeadline(target(1), nowMs + 2), "OVERDUE");
});
