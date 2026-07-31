import type { TaskStatus } from "@prisma/client";

export const TASK_SEGMENT_CREATABLE_STATUSES = [
  "DRAFT",
  "ACTIVE",
] as const satisfies readonly TaskStatus[];

/** Shared server/capability rule for creating or relinking a Segment to a Task. */
export function isTaskCreatableForSegment(status: TaskStatus): boolean {
  return TASK_SEGMENT_CREATABLE_STATUSES.some((candidate) => candidate === status);
}
