import type { UserRoleRecord } from "@/lib/permissions-client";

export function canAccessWorkshopFee(userRoles: UserRoleRecord[]): boolean {
  return userRoles.some(
    (role) => role.role === "SUPER_ADMIN" || role.role === "FINANCE",
  );
}

export function canCreateWorkshopFeeForTeam(
  userRoles: UserRoleRecord[],
  team: string,
): boolean {
  if (userRoles.some((role) => role.role === "SUPER_ADMIN")) return true;
  if (!team) return false;
  return userRoles.some(
    (role) => role.role === "FINANCE" && role.team === team,
  );
}
