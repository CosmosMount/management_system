import type {
  TaskMemberRole,
  TaskPriority,
  TaskStatus,
} from "@prisma/client";
import type { AuthorizationTaskResource } from "@/lib/project-management/authorization";

export type TaskAuthorizationResourceInput = {
  id?: string;
  team?: string;
  techGroup?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  members?: Array<{
    personId: string;
    role: TaskMemberRole;
    removedAt?: Date | null;
  }>;
};

export function taskAuthorizationResource(
  task: TaskAuthorizationResourceInput,
): AuthorizationTaskResource {
  return {
    type: "task",
    id: task.id,
    team: task.team,
    techGroup: task.techGroup,
    status: task.status,
    priority: task.priority,
    members: task.members,
  };
}
