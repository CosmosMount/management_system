import type { Prisma } from "@prisma/client";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { ProjectManagementServiceError } from "@/lib/project-management/application/errors";

/**
 * Refresh mutable role assignments inside the caller's transaction so that
 * authorization is evaluated against the same database snapshot as the write.
 */
export async function refreshProjectManagementActorTx(
  tx: Prisma.TransactionClient,
  actor: ProjectManagementActor,
): Promise<ProjectManagementActor> {
  await tx.$queryRaw`
    SELECT "id"
    FROM "Person"
    WHERE "id" = ${actor.personId}
    FOR UPDATE
  `;
  const account = await tx.account.findUnique({
    where: { id: actor.accountId },
    select: {
      person: { select: { id: true, status: true } },
      systemRoles: {
        where: { revokedAt: null },
        select: { role: true, team: true, techGroup: true },
      },
    },
  });
  if (
    !account?.person ||
    account.person.id !== actor.personId ||
    account.person.status !== "ACTIVE"
  ) {
    throw new ProjectManagementServiceError(
      "FORBIDDEN",
      "人员已停用，无法执行此操作",
    );
  }
  return { ...actor, isActive: true, systemRoles: account.systemRoles };
}
