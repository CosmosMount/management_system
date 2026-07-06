import type { UserRoleRecord } from "@/lib/permissions-client";
import { canManageProject } from "@/lib/permissions-progress";

type CommentPermissionProject = {
  team: string;
  techGroup: string;
  owners?: Array<{ openId: string }>;
  ownerOpenId?: string;
};

export function canDeleteProjectComment({
  roles,
  project,
  authorOpenId,
  userOpenId,
}: {
  roles: UserRoleRecord[];
  project: CommentPermissionProject;
  authorOpenId: string;
  userOpenId?: string;
}): boolean {
  if (!userOpenId) return false;
  if (authorOpenId === userOpenId) return true;
  const ownerOpenIds = project.owners?.map((owner) => owner.openId).filter(Boolean) ?? [];
  if (ownerOpenIds.length === 0 && project.ownerOpenId) {
    ownerOpenIds.push(project.ownerOpenId);
  }
  return canManageProject(
    roles,
    { team: project.team, techGroup: project.techGroup },
    ownerOpenIds,
    userOpenId,
  );
}
