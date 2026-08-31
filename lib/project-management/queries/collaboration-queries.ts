import {
  authorize,
  isSystemAdministrator,
} from "@/lib/project-management/authorization";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import {
  loadReadableTarget,
  targetResource,
  type TargetType,
} from "@/lib/project-management/queries/collaboration-query-support";

export {
  getActivityVersion,
  getRecentActivityPage,
} from "@/lib/project-management/queries/collaboration-activity-queries";
export type { RecentActivityPageDto } from "@/lib/project-management/queries/collaboration-activity-queries";
export {
  getCommentPage,
} from "@/lib/project-management/queries/collaboration-comment-queries";
export type {
  CommentItemDto,
  CommentPageDto,
} from "@/lib/project-management/queries/collaboration-comment-queries";
export {
  getRiskPage,
} from "@/lib/project-management/queries/collaboration-risk-queries";
export type {
  RiskItemDto,
  RiskPageDto,
} from "@/lib/project-management/queries/collaboration-risk-queries";
export type { RecentActivityItemDto } from "@/lib/project-management/recent-activity-formatter";

export type CollaborationCapabilities = {
  canCreateRisk: boolean;
  canCreateComment: boolean;
  canDeleteComment: boolean;
};

export async function getCollaborationCapabilities(
  actor: ProjectManagementActor,
  input: { targetType: TargetType; targetId: string },
): Promise<CollaborationCapabilities> {
  const target = await loadReadableTarget(actor, input.targetType, input.targetId);
  const resource = targetResource(target);
  const canCreateRisk =
    target.status === "ACTIVE" &&
    authorize({
      actor,
      action: target.type === "PROJECT" ? "project.risk.create" : "task.risk.create",
      resource,
    }).allowed;
  return {
    canCreateRisk,
    canCreateComment: authorize({
      actor,
      action:
        target.type === "PROJECT"
          ? "project.comment.create"
          : "task.comment.create",
      resource,
    }).allowed,
    canDeleteComment: isSystemAdministrator(actor),
  };
}
