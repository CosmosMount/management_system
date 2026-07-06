import type { OrderStatus, UserRoleType } from "@prisma/client";
import { getOpenIdsByRole } from "@/lib/permissions";
import { roleLabels, statusApproverRole } from "@/lib/permissions-client";
import { prisma } from "@/lib/prisma";

export type OrderForHandlerLookup = {
  id: string;
  status: OrderStatus;
  team: string;
  techGroup: string;
  initiatorName: string;
  teamApproved: boolean;
  techGroupApproved: boolean;
};

type RoleScope = {
  role: UserRoleType;
  team: string;
  techGroup: string;
};

function roleScopeKey(scope: RoleScope): string {
  return `${scope.role}:${scope.team}:${scope.techGroup}`;
}

function roleFallbackLabel(scope: RoleScope): string {
  const base = roleLabels[scope.role];
  if (
    (scope.role === "TECH_GROUP_ADMIN" || scope.role === "TEACHER") &&
    scope.techGroup
  ) {
    return `${base}（${scope.techGroup}）`;
  }
  if (scope.team) {
    return `${base}（${scope.team}）`;
  }
  return base;
}

function collectRoleScopes(order: OrderForHandlerLookup): RoleScope[] {
  if (order.status === "MANAGEMENT_REVIEW") {
    const scopes: RoleScope[] = [];
    if (!order.teamApproved) {
      scopes.push({
        role: "TEAM_ADMIN",
        team: order.team,
        techGroup: "",
      });
    }
    if (!order.techGroupApproved) {
      scopes.push({
        role: "TECH_GROUP_ADMIN",
        team: "",
        techGroup: order.techGroup,
      });
    }
    return scopes;
  }

  if (
    order.status === "PENDING_APPLICANT_DOCS" ||
    order.status === "PENDING_APPLICANT_CONFIRM"
  ) {
    return [];
  }

  const role = statusApproverRole[order.status];
  if (!role) return [];

  if (role === "TEAM_ADMIN" || role === "FINANCE") {
    return [{ role, team: order.team, techGroup: "" }];
  }
  return [{ role, team: "", techGroup: order.techGroup }];
}

function formatHandlerNames(
  scopes: RoleScope[],
  namesByScope: Map<string, string[]>,
): string {
  const names = scopes.flatMap((scope) => namesByScope.get(roleScopeKey(scope)) ?? []);
  const unique = [...new Set(names)];
  if (unique.length > 0) {
    return unique.join("、");
  }
  if (scopes.length > 0) {
    return scopes.map(roleFallbackLabel).join("、");
  }
  return "—";
}

/** 批量解析在途订单当前环节的处理人姓名 */
export async function resolveProcurementHandlerNames(
  orders: OrderForHandlerLookup[],
): Promise<Map<string, string>> {
  const scopesByOrder = new Map<string, RoleScope[]>();
  const uniqueScopes = new Map<string, RoleScope>();

  for (const order of orders) {
    if (
      order.status === "PENDING_APPLICANT_DOCS" ||
      order.status === "PENDING_APPLICANT_CONFIRM"
    ) {
      continue;
    }
    const scopes = collectRoleScopes(order);
    scopesByOrder.set(order.id, scopes);
    for (const scope of scopes) {
      uniqueScopes.set(roleScopeKey(scope), scope);
    }
  }

  const namesByScope = new Map<string, string[]>();
  await Promise.all(
    [...uniqueScopes.values()].map(async (scope) => {
      const openIds = await getOpenIdsByRole(scope.role, {
        team: scope.team,
        techGroup: scope.techGroup,
      });
      if (openIds.length === 0) {
        namesByScope.set(roleScopeKey(scope), []);
        return;
      }
      const users = await prisma.user.findMany({
        where: { openId: { in: openIds } },
        select: { name: true },
        orderBy: { name: "asc" },
      });
      namesByScope.set(
        roleScopeKey(scope),
        users.map((user) => user.name),
      );
    }),
  );

  const result = new Map<string, string>();
  for (const order of orders) {
    if (
      order.status === "PENDING_APPLICANT_DOCS" ||
      order.status === "PENDING_APPLICANT_CONFIRM"
    ) {
      result.set(order.id, order.initiatorName);
      continue;
    }
    const scopes = scopesByOrder.get(order.id) ?? [];
    result.set(order.id, formatHandlerNames(scopes, namesByScope));
  }

  return result;
}
