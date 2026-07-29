import type { ResourceConflictStatus } from "@prisma/client";
import {
  authorize,
  isSystemAdministrator,
  type AuthorizationTaskResource,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

type ConflictAuthorizationTask = Omit<AuthorizationTaskResource, "type"> & {
  id: string;
};

export type ConflictAuthorizationResource = {
  personId: string;
  status: ResourceConflictStatus;
  segments: ReadonlyArray<{
    segment: {
      task: ConflictAuthorizationTask | null;
    };
  }>;
};

export type ResourceConflictCapabilities = {
  canAcknowledge: boolean;
  canResolve: boolean;
  canIgnore: boolean;
  canPreviewSuggestion: boolean;
  canApplySuggestion: boolean;
};

export function canFullyHandleConflict(
  actor: ProjectManagementActor,
  conflict: ConflictAuthorizationResource,
): boolean {
  if (isSystemAdministrator(actor)) return true;
  if (conflict.segments.some((entry) => !entry.segment.task)) return false;

  const tasks = uniqueConflictTasks(conflict);
  if (tasks.length === 0) return false;

  if (
    tasks.every((task) =>
      authorize({
        actor,
        action: "conflict.resolve",
        resource: { ...task, type: "task" },
      }).allowed,
    )
  ) {
    return true;
  }

  return tasks.every((task) =>
    task.members?.some(
      (member) =>
        member.personId === actor.personId &&
        member.role === "OWNER" &&
        member.removedAt == null,
    ),
  );
}

export function resourceConflictCapabilities(
  actor: ProjectManagementActor,
  conflict: ConflictAuthorizationResource,
): ResourceConflictCapabilities {
  const canHandle = canFullyHandleConflict(actor, conflict);
  const canAcknowledgeActor = conflict.personId === actor.personId || canHandle;
  const isUnresolved = conflict.status !== "RESOLVED";

  return {
    canAcknowledge:
      (conflict.status === "OPEN" || conflict.status === "ACKNOWLEDGED") &&
      canAcknowledgeActor,
    canResolve: canHandle,
    canIgnore: isUnresolved && canHandle,
    canPreviewSuggestion: canHandle,
    canApplySuggestion: isUnresolved && canHandle,
  };
}

function uniqueConflictTasks(conflict: ConflictAuthorizationResource) {
  const tasks = new Map<string, ConflictAuthorizationTask>();
  for (const entry of conflict.segments) {
    const task = entry.segment.task;
    if (task) tasks.set(task.id, task);
  }
  return [...tasks.values()];
}
