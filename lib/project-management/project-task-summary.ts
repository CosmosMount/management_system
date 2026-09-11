import type { TaskStatus } from "@prisma/client";
import { compareDeadlineTasks, evaluateDeadline, type CurrentNodeDeadline } from "@/lib/project-management/current-node-deadline";

export type ProjectTaskSummaryItem = {
  id: string;
  title: string;
  status: "DRAFT" | "ACTIVE";
  currentNodeDeadline: CurrentNodeDeadline | null;
};

export function summarizeProjectTaskCounts(counts: readonly { status: TaskStatus; count: number }[]) {
  const taskStatusCounts = { DRAFT: 0, ACTIVE: 0, COMPLETED: 0, FAILED: 0, TIMEOUT: 0, ARCHIVED: 0 };
  let taskCount = 0;
  let completionTaskTotalCount = 0;
  for (const entry of counts) {
    taskCount += entry.count;
    if (entry.status === "CANCELLED") continue;
    taskStatusCounts[entry.status] += entry.count;
    completionTaskTotalCount += entry.count;
  }
  return { taskCount, completionTaskTotalCount, completedTaskCount: taskStatusCounts.COMPLETED, taskStatusCounts };
}

export function getProjectTaskOverview(tasks: readonly ProjectTaskSummaryItem[], nowMs: number) {
  const sortedTasks = [...tasks].sort((left, right) => compareDeadlineTasks(left, right, nowMs));
  let overdueCount = 0;
  let dueSoonCount = 0;
  for (const task of sortedTasks) {
    const deadline = evaluateDeadline(task.currentNodeDeadline, nowMs);
    if (deadline === "OVERDUE") overdueCount += 1;
    if (deadline === "DUE_SOON") dueSoonCount += 1;
  }
  return { tasks: sortedTasks, overdueCount, dueSoonCount };
}
