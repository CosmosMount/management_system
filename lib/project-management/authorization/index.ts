import type {
  TaskMemberRole,
  TaskPriority,
  TaskStatus,
  ProjectStatus,
  ProjectMemberRole,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

export const PROJECT_MANAGEMENT_ACTIONS = [
  "tag.create",
  "tag.update",
  "tag.delete",
  "project.create",
  "project.view",
  "project.update",
  "project.manage_members",
  "project.submit_establishment",
  "project.review_establishment",
  "project.complete",
  "project.delete",
  "task.create",
  "task.view",
  "task.update_metadata",
  "task.manage_members",
  "task.activate",
  "task.archive",
  "plan.view_history",
  "revision.create",
  "revision.review",
  "revision.apply",
  "milestone.submit_review",
  "milestone.review",
  "task.terminate",
  "segment.view",
  "segment.manage_self",
  "segment.manage_others",
  "audit.view",
] as const;

export type ProjectManagementAction =
  (typeof PROJECT_MANAGEMENT_ACTIONS)[number];

export type AuthorizationDecision = {
  allowed: boolean;
  reason: string;
};

export type AuthorizationMember = {
  personId: string;
  role: TaskMemberRole;
  removedAt?: Date | null;
};

export type AuthorizationTaskResource = {
  type: "task";
  id?: string;
  team?: string;
  techGroup?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  members?: AuthorizationMember[];
};

export type AuthorizationTagResource = {
  type: "tag";
  createdByAccountId?: string | null;
};

export type AuthorizationProjectResource = {
  type: "project";
  id?: string;
  status?: ProjectStatus;
  requesterAccountId?: string | null;
  members?: Array<{
    personId: string;
    role: ProjectMemberRole;
    removedAt?: Date | null;
  }>;
};

export type AuthorizationSegmentResource = {
  type: "segment";
  personId?: string | null;
  task?: AuthorizationTaskResource | null;
};

export type AuthorizationAuditResource = {
  type: "audit";
  task?: AuthorizationTaskResource | null;
  actorAccountId?: string | null;
};

export type AuthorizationResource =
  | AuthorizationTaskResource
  | AuthorizationProjectResource
  | AuthorizationTagResource
  | AuthorizationSegmentResource
  | AuthorizationAuditResource
  | { type: "system"; team?: string; techGroup?: string };

export class ProjectManagementAuthorizationError extends Error {
  constructor(
    readonly action: ProjectManagementAction,
    readonly reason: string,
  ) {
    super("你没有执行此操作的权限");
    this.name = "ProjectManagementAuthorizationError";
  }
}

export function authorize({
  actor,
  action,
  resource,
}: {
  actor: ProjectManagementActor;
  action: ProjectManagementAction;
  resource: AuthorizationResource;
}): AuthorizationDecision {
  if (isSystemAdministrator(actor)) {
    return allow("global_administrator");
  }

  if (resource.type === "tag") {
    return authorizeTag(actor, action, resource);
  }
  if (resource.type === "project") {
    return authorizeProject(actor, action, resource);
  }
  if (resource.type === "segment") {
    return authorizeSegment(actor, action, resource);
  }
  if (resource.type === "audit") {
    return authorizeAudit(actor, action, resource);
  }
  if (resource.type === "task") {
    return authorizeTask(actor, action, resource);
  }
  return authorizeSystemScoped(actor, action, resource);
}

function authorizeProject(
  actor: ProjectManagementActor,
  action: ProjectManagementAction,
  resource: AuthorizationProjectResource,
): AuthorizationDecision {
  if (action === "project.create" || action === "project.view") {
    return allow("authenticated_project_access");
  }
  if (action === "project.review_establishment") {
    return deny("global_administrator_required");
  }
  const isOwner = resource.members?.some(
    (member) =>
      member.personId === actor.personId &&
      member.role === "OWNER" &&
      !member.removedAt,
  );
  if (
    resource.status === "DRAFT" &&
    resource.requesterAccountId === actor.accountId &&
    (action === "project.update" ||
      action === "project.manage_members" ||
      action === "project.submit_establishment")
  ) {
    return allow("project_requester_draft_exception");
  }
  if (isOwner) {
    if (
      action === "project.update" ||
      action === "project.manage_members" ||
      action === "project.submit_establishment" ||
      action === "project.complete" ||
      action === "project.delete"
    ) {
      return allow("project_owner");
    }
  }
  return deny("project_policy_denied");
}

export function assertAuthorized(input: {
  actor: ProjectManagementActor;
  action: ProjectManagementAction;
  resource: AuthorizationResource;
}): void {
  const decision = authorize(input);
  if (!decision.allowed) {
    throw new ProjectManagementAuthorizationError(input.action, decision.reason);
  }
}

function authorizeTag(
  actor: ProjectManagementActor,
  action: ProjectManagementAction,
  resource: AuthorizationTagResource,
): AuthorizationDecision {
  if (action === "tag.create") return allow("authenticated");
  if (
    (action === "tag.update" || action === "tag.delete") &&
    resource.createdByAccountId === actor.accountId
  ) {
    return allow("tag_creator");
  }
  return deny("tag_does_not_grant_task_permission");
}

function authorizeSegment(
  actor: ProjectManagementActor,
  action: ProjectManagementAction,
  resource: AuthorizationSegmentResource,
): AuthorizationDecision {
  if (action === "segment.view") {
    return allow("global_segment_visibility");
  }
  if (action === "segment.manage_self" && resource.personId === actor.personId) {
    if (!resource.task) return allow("unlinked_segment_self");
    if (hasTaskRole(actor, resource.task, ["OWNER", "PARTICIPANT"])) {
      return allow("task_member_segment_self");
    }
  }
  if (
    action === "segment.manage_others" &&
    resource.task &&
    hasTaskRole(actor, resource.task, ["OWNER"])
  ) {
    return allow("task_owner_segment_management");
  }
  return deny("segment_policy_denied");
}

function authorizeAudit(
  actor: ProjectManagementActor,
  action: ProjectManagementAction,
  resource: AuthorizationAuditResource,
): AuthorizationDecision {
  if (action !== "audit.view") return deny("audit_action_mismatch");
  if (resource.task && authorizeTask(actor, "task.view", resource.task).allowed) {
    return allow("task_readable_audit");
  }
  if (resource.actorAccountId === actor.accountId) {
    return allow("actor_own_audit");
  }
  return deny("audit_policy_denied");
}

function authorizeTask(
  actor: ProjectManagementActor,
  action: ProjectManagementAction,
  resource: AuthorizationTaskResource,
): AuthorizationDecision {
  if (action === "task.create") {
    return allow("active_project_account");
  }

  if (
    action === "task.view" ||
    action === "plan.view_history" ||
    action === "audit.view"
  ) {
    return allow("global_task_visibility");
  }

  if (action === "milestone.submit_review") {
    if (hasTaskRole(actor, resource, ["OWNER", "PARTICIPANT"])) {
      return allow("milestone_submitter");
    }
    return deny("milestone_submit_denied");
  }

  if (action === "task.update_metadata" || action === "revision.create") {
    if (hasTaskRole(actor, resource, ["OWNER", "PARTICIPANT"])) {
      return allow("task_editor");
    }
    return deny("task_edit_denied");
  }

  if (action === "task.manage_members" || action === "task.activate") {
    if (hasTaskRole(actor, resource, ["OWNER"])) return allow("task_owner");
    return deny("task_owner_required");
  }

  if (action === "task.archive") {
    if (hasTaskRole(actor, resource, ["OWNER"])) return allow("task_owner");
    return deny("task_archive_denied");
  }

  if (action === "revision.review" || action === "milestone.review") {
    return deny("global_administrator_required");
  }

  if (action === "revision.apply") {
    return deny("global_administrator_required");
  }

  if (action === "task.terminate") {
    return hasTaskRole(actor, resource, ["OWNER"])
      ? allow("task_owner")
      : deny("task_owner_required");
  }

  return deny("unsupported_action_for_task");
}

function authorizeSystemScoped(
  actor: ProjectManagementActor,
  action: ProjectManagementAction,
  resource: { type: "system"; team?: string; techGroup?: string },
): AuthorizationDecision {
  void actor;
  void resource;
  if (action === "task.create") return allow("active_project_account");
  return deny("system_scope_denied");
}

export function taskReadableWhere(
  actor: ProjectManagementActor,
): Prisma.TaskWhereInput {
  void actor;
  return { deletedAt: null };
}

export function projectReadableWhere(
  actor: ProjectManagementActor,
): Prisma.ProjectWhereInput {
  void actor;
  return { deletedAt: null };
}

export function segmentReadableWhere(
  actor: ProjectManagementActor,
): Prisma.WorkSegmentWhereInput {
  void actor;
  return { deletedAt: null };
}

export function tagReadableWhere(
  actor: ProjectManagementActor,
): Prisma.TagWhereInput {
  void actor;
  return { archivedAt: null };
}

export function auditReadableWhere(
  actor: ProjectManagementActor,
): Prisma.DomainAuditEventWhereInput {
  const readableTasks = taskReadableWhere(actor);
  return {
    OR: [
      { actorAccountId: actor.accountId },
      { task: readableTasks },
      { project: projectReadableWhere(actor) },
    ],
  };
}

export function notificationReadableWhere(
  actor: ProjectManagementActor,
): Prisma.InAppNotificationWhereInput {
  return { recipientAccountId: actor.accountId };
}

export function isSystemAdministrator(actor: ProjectManagementActor): boolean {
  return actor.systemRoles.some(
    (role) =>
      (role.role === "SUPER_ADMINISTRATOR" ||
        role.role === "PROJECT_ADMINISTRATOR") &&
      !role.team &&
      !role.techGroup,
  );
}

function hasTaskRole(
  actor: ProjectManagementActor,
  resource: AuthorizationTaskResource,
  roles: TaskMemberRole[],
): boolean {
  return (
    resource.members?.some(
      (member) =>
        member.personId === actor.personId &&
        member.removedAt == null &&
        roles.includes(member.role),
    ) ?? false
  );
}

function allow(reason: string): AuthorizationDecision {
  return { allowed: true, reason };
}

function deny(reason: string): AuthorizationDecision {
  return { allowed: false, reason };
}
