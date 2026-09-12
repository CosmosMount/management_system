import type { ProjectManagementActor } from "@/lib/project-management/identity";

export function canManageMeetings(actor: ProjectManagementActor): boolean {
  return actor.isActive !== false && actor.systemRoles.some((role) =>
    role.role === "SUPER_ADMINISTRATOR" && !role.team && !role.techGroup,
  );
}
