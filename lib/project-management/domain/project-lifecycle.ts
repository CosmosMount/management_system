import type { TaskStatus } from "@prisma/client";

export const PROJECT_COMPLETION_BLOCKING_TASK_STATUSES = [
  "DRAFT",
  "ACTIVE",
] as const satisfies readonly TaskStatus[];

export function isProjectCompletionBlockingTaskStatus(
  status: TaskStatus,
): boolean {
  return PROJECT_COMPLETION_BLOCKING_TASK_STATUSES.some(
    (candidate) => candidate === status,
  );
}
