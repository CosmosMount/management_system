import type { ProjectManagementActor } from "@/lib/project-management/identity";

export function canDeleteMaterial(
  actor: ProjectManagementActor,
  createdByAccountId: string,
): boolean {
  return actor.isActive === true && (
    actor.accountId === createdByAccountId || actor.systemRoles.some((role) =>
      role.role === "SUPER_ADMINISTRATOR" && !role.team && !role.techGroup,
    )
  );
}
