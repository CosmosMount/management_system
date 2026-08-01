import type {
  ProjectManagementSystemRole,
  TaskMemberRole,
  TaskPriority,
  TaskStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type {
  ProjectManagementActor,
  ProjectManagementSystemRoleRecord,
} from "@/lib/project-management/identity";

export const PROJECT_MANAGEMENT_ACTIONS = [
  "tag.create",
  "tag.update",
  "tag.delete",
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
  "conflict.view",
  "conflict.resolve",
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
  allowSelfReview?: boolean;
  submittedByAccountId?: string | null;
  members?: AuthorizationMember[];
};

export type AuthorizationTagResource = {
  type: "tag";
  createdByAccountId?: string | null;
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
    if (
      actionRequiresSelfReviewCheck(action) &&
      isSelfReview(actor, resource) &&
      !selfReviewAllowed(resource)
    ) {
      return deny("self_review_denied");
    }
    return allow("system_administrator");
  }

  if (
    actionRequiresSelfReviewCheck(action) &&
    isSelfReview(actor, resource) &&
    !selfReviewAllowed(resource)
  ) {
    return deny("self_review_denied");
  }

  if (resource.type === "tag") {
    return authorizeTag(actor, action, resource);
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
    if (resource.personId === actor.personId) return allow("segment_self");
    if (resource.task && authorizeTask(actor, "task.view", resource.task).allowed) {
      return allow("task_context");
    }
    if (hasScopedRole(actor, ["GROUP_LEADER"], resource.task)) {
      return allow("resource_scope");
    }
  }
  if (action === "segment.manage_self" && resource.personId === actor.personId) {
    return allow("segment_self");
  }
  if (
    action === "segment.manage_others" &&
    hasScopedRole(actor, ["GROUP_LEADER"], resource.task)
  ) {
    return allow("group_leader_scope");
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
    return hasScopedRole(actor, ["GROUP_LEADER"], resource)
      ? allow("group_leader_scope")
      : deny("task_create_scope_denied");
  }

  if (
    action === "task.view" ||
    action === "plan.view_history" ||
    action === "conflict.view" ||
    action === "audit.view"
  ) {
    if (hasTaskRole(actor, resource, ["OWNER", "LEAD", "MEMBER", "REVIEWER", "VIEWER"])) {
      return allow("task_member");
    }
    if (hasScopedRole(actor, ["GROUP_LEADER"], resource)) {
      return allow("scoped_task_reader");
    }
    return deny("task_not_readable");
  }

  if (action === "milestone.submit_review") {
    if (hasTaskRole(actor, resource, ["OWNER", "LEAD", "MEMBER"])) {
      return allow("milestone_submitter");
    }
    if (hasScopedRole(actor, ["GROUP_LEADER"], resource)) {
      return allow("group_leader_scope");
    }
    return deny("milestone_submit_denied");
  }

  if (action === "task.update_metadata" || action === "revision.create") {
    if (hasTaskRole(actor, resource, ["OWNER", "LEAD"])) {
      return allow("task_editor");
    }
    if (hasScopedRole(actor, ["GROUP_LEADER"], resource)) {
      return allow("group_leader_scope");
    }
    return deny("task_edit_denied");
  }

  if (action === "task.manage_members" || action === "task.activate") {
    if (hasTaskRole(actor, resource, ["OWNER"])) return allow("task_owner");
    if (hasScopedRole(actor, ["GROUP_LEADER"], resource)) {
      return allow("group_leader_scope");
    }
    return deny("task_owner_required");
  }

  if (action === "task.archive") {
    if (hasTaskRole(actor, resource, ["OWNER"])) return allow("task_owner");
    if (hasScopedRole(actor, ["GROUP_LEADER"], resource)) {
      return allow("group_leader_scope");
    }
    return deny("task_archive_denied");
  }

  if (action === "revision.review" || action === "milestone.review") {
    if (hasTaskRole(actor, resource, ["REVIEWER"])) return allow("task_reviewer");
    if (hasScopedRole(actor, ["GROUP_LEADER"], resource)) {
      return allow("group_leader_scope");
    }
    return deny("reviewer_required");
  }

  if (action === "revision.apply") {
    if (hasTaskRole(actor, resource, ["OWNER"])) return allow("task_owner");
    if (hasScopedRole(actor, ["GROUP_LEADER"], resource)) {
      return allow("group_leader_scope");
    }
    return deny("revision_apply_denied");
  }

  if (action === "task.terminate") {
    if (hasTaskRole(actor, resource, ["OWNER", "REVIEWER"])) {
      return allow("task_owner_or_reviewer");
    }
    if (hasScopedRole(actor, ["GROUP_LEADER"], resource)) {
      return allow("group_leader_scope");
    }
    return deny("task_terminate_denied");
  }

  if (action === "conflict.resolve") {
    if (hasScopedRole(actor, ["GROUP_LEADER"], resource)) {
      return allow("conflict_manager_scope");
    }
    return deny("conflict_resolve_denied");
  }

  return deny("unsupported_action_for_task");
}

function authorizeSystemScoped(
  actor: ProjectManagementActor,
  action: ProjectManagementAction,
  resource: { type: "system"; team?: string; techGroup?: string },
): AuthorizationDecision {
  if (action === "task.create" && hasScopedRole(actor, ["GROUP_LEADER"], resource)) {
    return allow("group_leader_scope");
  }
  if (
    action === "segment.manage_others" &&
    hasScopedRole(actor, ["GROUP_LEADER"], resource)
  ) {
    return allow("group_leader_scope");
  }
  return deny("system_scope_denied");
}

export function taskReadableWhere(
  actor: ProjectManagementActor,
): Prisma.TaskWhereInput {
  if (isSystemAdministrator(actor)) {
    return { deletedAt: null };
  }
  const or: Prisma.TaskWhereInput[] = [
    { members: { some: { personId: actor.personId, removedAt: null } } },
    ...scopedTaskWhere(actor, ["GROUP_LEADER"]),
  ];
  return or.length > 0 ? { deletedAt: null, OR: or } : neverTaskWhere();
}

export function segmentReadableWhere(
  actor: ProjectManagementActor,
): Prisma.WorkSegmentWhereInput {
  if (isSystemAdministrator(actor)) {
    return { deletedAt: null };
  }
  return {
    deletedAt: null,
    OR: [
      { personId: actor.personId },
      { task: taskReadableWhere(actor) },
      ...scopedTaskWhere(actor, ["GROUP_LEADER"]).map(
        (task) => ({ task }),
      ),
    ],
  };
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
  if (isSystemAdministrator(actor)) return {};
  return {
    OR: [
      { actorAccountId: actor.accountId },
      { task: taskReadableWhere(actor) },
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

function hasScopedRole(
  actor: ProjectManagementActor,
  roles: ProjectManagementSystemRole[],
  resource:
    | Pick<AuthorizationTaskResource, "team" | "techGroup">
    | AuthorizationTaskResource
    | { team?: string; techGroup?: string }
    | null
    | undefined,
): boolean {
  return actor.systemRoles.some(
    (role) => roles.includes(role.role) && roleScopeMatches(role, resource),
  );
}

function roleScopeMatches(
  role: ProjectManagementSystemRoleRecord,
  resource:
    | Pick<AuthorizationTaskResource, "team" | "techGroup">
    | { team?: string; techGroup?: string }
    | null
    | undefined,
): boolean {
  const roleTeam = role.team.trim();
  const roleTechGroup = role.techGroup.trim();
  if (!roleTeam && !roleTechGroup) {
    return (
      role.role === "SUPER_ADMINISTRATOR" ||
      role.role === "PROJECT_ADMINISTRATOR"
    );
  }
  if (!resource) return false;
  if (roleTeam && roleTeam !== resource.team) return false;
  if (roleTechGroup && roleTechGroup !== resource.techGroup) return false;
  return true;
}

function scopedTaskWhere(
  actor: ProjectManagementActor,
  roles: ProjectManagementSystemRole[],
): Prisma.TaskWhereInput[] {
  return actor.systemRoles
    .filter(
      (role) => roles.includes(role.role) && roleCanProduceTaskScopeWhere(role),
    )
    .map((role) => {
      const where: Prisma.TaskWhereInput = {};
      const team = role.team.trim();
      const techGroup = role.techGroup.trim();
      if (team) where.team = team;
      if (techGroup) where.techGroup = techGroup;
      return where;
    });
}

function roleCanProduceTaskScopeWhere(
  role: ProjectManagementSystemRoleRecord,
): boolean {
  const hasScope = role.team.trim().length > 0 || role.techGroup.trim().length > 0;
  return (
    hasScope ||
    role.role === "SUPER_ADMINISTRATOR" ||
    role.role === "PROJECT_ADMINISTRATOR"
  );
}

function isSelfReview(
  actor: ProjectManagementActor,
  resource: AuthorizationResource,
): boolean {
  return (
    "submittedByAccountId" in resource &&
    resource.submittedByAccountId === actor.accountId
  );
}

function actionRequiresSelfReviewCheck(
  action: ProjectManagementAction,
): boolean {
  return action === "revision.review" || action === "milestone.review";
}

function selfReviewAllowed(resource: AuthorizationResource): boolean {
  return "allowSelfReview" in resource && resource.allowSelfReview === true;
}

function allow(reason: string): AuthorizationDecision {
  return { allowed: true, reason };
}

function deny(reason: string): AuthorizationDecision {
  return { allowed: false, reason };
}

function neverTaskWhere(): Prisma.TaskWhereInput {
  return { id: { in: [] } };
}
