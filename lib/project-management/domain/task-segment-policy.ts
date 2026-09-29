import type { TaskMemberRole, TaskStatus } from "@prisma/client";

export const TASK_SEGMENT_CREATABLE_STATUSES = [
  "DRAFT",
  "ACTIVE",
] as const satisfies readonly TaskStatus[];

/** Shared server/capability rule for creating or relinking a Segment to a Task. */
export function isTaskCreatableForSegment(status: TaskStatus): boolean {
  return TASK_SEGMENT_CREATABLE_STATUSES.some((candidate) => candidate === status);
}

/** Keep displayed edit capabilities consistent with mutation association guards. */
export function hasValidSegmentTaskMember(
  personId: string,
  task: { members: readonly { personId: string; role: TaskMemberRole; removedAt?: Date | null }[] } | null,
): boolean {
  return !task || task.members.some((member) =>
    member.personId === personId && member.removedAt == null &&
    (member.role === "OWNER" || member.role === "PARTICIPANT"),
  );
}
