import assert from "node:assert/strict";
import test from "node:test";
import { getProjectTaskOverview, summarizeProjectTaskCounts, type ProjectTaskSummaryItem } from "../lib/project-management/project-task-summary";

const nowMs = Date.parse("2026-09-11T10:00:00+08:00");

test("项目完成进度排除取消任务，但保留其他终态计数", () => {
  const result = summarizeProjectTaskCounts([
    { status: "DRAFT", count: 2 }, { status: "ACTIVE", count: 3 },
    { status: "COMPLETED", count: 5 }, { status: "CANCELLED", count: 7 },
    { status: "FAILED", count: 1 }, { status: "TIMEOUT", count: 2 }, { status: "ARCHIVED", count: 1 },
  ]);
  assert.equal(result.taskCount, 21);
  assert.equal(result.completionTaskTotalCount, 14);
  assert.equal(result.completedTaskCount, 5);
  assert.deepEqual(result.taskStatusCounts, { DRAFT: 2, ACTIVE: 3, COMPLETED: 5, FAILED: 1, TIMEOUT: 2, ARCHIVED: 1 });
  assert.equal(summarizeProjectTaskCounts([]).completionTaskTotalCount, 0);
  assert.equal(summarizeProjectTaskCounts([{ status: "CANCELLED", count: 4 }]).completionTaskTotalCount, 0);
});

test("项目概览先按全量期限排序，预警独立计数且随时钟更新", () => {
  const makeTask = (id: string, offset: number | null): ProjectTaskSummaryItem => ({
    id, title: id, status: offset === null ? "DRAFT" : "ACTIVE",
    currentNodeDeadline: offset === null ? null : { nodeId: id, nodeType: "MILESTONE", dueAt: new Date(nowMs + offset).toISOString() },
  });
  const source = [makeTask("草稿", null), makeTask("正常", 73 * 3_600_000), makeTask("临期", 72 * 3_600_000), makeTask("到期瞬间", 0), makeTask("逾期", -1)];
  const overview = getProjectTaskOverview(source, nowMs);
  assert.deepEqual(overview.tasks.map((task) => task.id), ["逾期", "到期瞬间", "临期", "正常", "草稿"]);
  assert.equal(overview.overdueCount, 1);
  assert.equal(overview.dueSoonCount, 2);
  assert.equal(source[0].id, "草稿");
  const refreshed = getProjectTaskOverview(source, nowMs + 3_600_001);
  assert.equal(refreshed.overdueCount, 2);
  assert.equal(refreshed.dueSoonCount, 2);
  assert.deepEqual(getProjectTaskOverview([], nowMs), { tasks: [], overdueCount: 0, dueSoonCount: 0 });
});
