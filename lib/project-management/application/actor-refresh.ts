import type { Prisma } from "@prisma/client";
import type { ProjectManagementActor } from "@/lib/project-management/identity";

/**
 * Refresh mutable role assignments inside the caller's transaction so that
 * authorization is evaluated against the same database snapshot as the write.
 */
export async function refreshProjectManagementActorTx(
  tx: Prisma.TransactionClient,
  actor: ProjectManagementActor,
): Promise<ProjectManagementActor> {
  const systemRoles = await tx.systemRoleAssignment.findMany({
    where: { accountId: actor.accountId, revokedAt: null },
    select: { role: true, team: true, techGroup: true },
  });
  return { ...actor, systemRoles };
}
