import { prisma } from "@/lib/prisma";
import { resolveFeishuIdentityForUser } from "@/lib/project-management/identity/feishu-identity";
import {
  ProjectManagementIdentityError,
  type ProjectManagementActor,
  type ProjectManagementIdentityInput,
} from "@/lib/project-management/identity/identity-types";

export async function getCurrentProjectManagementActor(): Promise<ProjectManagementActor> {
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  if (!session?.user?.openId) {
    throw new ProjectManagementIdentityError(
      "UNAUTHENTICATED",
      "请重新登录",
    );
  }
  return getProjectManagementActorForFeishuUser({
    openId: session.user.openId,
    unionId: session.user.unionId,
    name: session.user.name,
    avatar: session.user.image,
  });
}

export async function getProjectManagementActorForFeishuUser(
  input: ProjectManagementIdentityInput,
): Promise<ProjectManagementActor> {
  const resolved = await resolveFeishuIdentityForUser(input);
  const systemRoles =
    resolved.person.status === "ACTIVE"
      ? await prisma.systemRoleAssignment.findMany({
          where: {
            accountId: resolved.account.id,
            revokedAt: null,
          },
          select: {
            role: true,
            team: true,
            techGroup: true,
          },
        })
      : [];
  return {
    accountId: resolved.account.id,
    personId: resolved.person.id,
    openId: input.openId,
    unionId: input.unionId,
    isActive: resolved.person.status === "ACTIVE",
    systemRoles,
  };
}
