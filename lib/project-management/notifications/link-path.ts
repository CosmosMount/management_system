import { routes } from "@/lib/routes";
import type { ProjectManagementNotificationPayload } from "@/lib/project-management/notifications/contract";

type ProjectManagementNotificationLinkInput = {
  kind: ProjectManagementNotificationPayload["kind"];
  linkPath?: string | null;
  taskId?: string | null;
  projectId?: string | null;
};

/**
 * Resolve the stable in-app destination for a project-management notification.
 *
 * Project/Task-scoped events must never fall back to "My Work" merely because
 * an individual producer omitted its link. Existing, more precise destinations
 * (for example a Terminal focus or Project establishment anchor) are preserved.
 */
export function resolveProjectManagementNotificationLinkPath(
  input: ProjectManagementNotificationLinkInput,
): string {
  if (input.kind === "task_deleted") return routes.progress.tasks;
  if (input.kind === "project_deleted") return routes.progress.projects;

  const explicitLinkPath = input.linkPath?.trim() ?? "";

  // Historical segment links still open records in the unified My Work view.
  if (input.kind === "segment_confirmation_due") {
    return explicitLinkPath.startsWith(`${routes.progress.root}?focus=`)
      ? explicitLinkPath
      : routes.progress.root;
  }

  if (input.taskId) {
    return entityLinkPath(
      explicitLinkPath,
      routes.progress.taskDetail(input.taskId),
    );
  }
  if (input.projectId) {
    return entityLinkPath(
      explicitLinkPath,
      routes.progress.projectDetail(input.projectId),
    );
  }
  return explicitLinkPath || routes.progress.root;
}

function entityLinkPath(explicitLinkPath: string, entityPath: string): string {
  if (
    explicitLinkPath === entityPath ||
    explicitLinkPath.startsWith(`${entityPath}?`) ||
    explicitLinkPath.startsWith(`${entityPath}#`)
  ) {
    return explicitLinkPath;
  }
  return entityPath;
}
