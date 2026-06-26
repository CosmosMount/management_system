"use server";

import { revalidatePath } from "next/cache";
import type { UserRoleType } from "@prisma/client";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import { requireSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

const TEAM_SCOPED_ROLES = new Set<UserRoleType>(["TEAM_ADMIN"]);
const TECH_GROUP_SCOPED_ROLES = new Set<UserRoleType>([
  "TECH_GROUP_ADMIN",
  "TEACHER",
  "FINANCE",
]);
const GLOBAL_ROLES = new Set<UserRoleType>(["SUPER_ADMIN", "PROJECT_MANAGER"]);

function resolveRoleScope(
  role: UserRoleType,
  team?: string,
  techGroup?: string,
): { team: string; techGroup: string } {
  if (TEAM_SCOPED_ROLES.has(role)) {
    const resolvedTeam = team ?? "";
    if (!resolvedTeam || !(TEAM_OPTIONS as readonly string[]).includes(resolvedTeam)) {
      throw new Error("车组组长必须指定有效车组");
    }
    return { team: resolvedTeam, techGroup: "" };
  }

  if (TECH_GROUP_SCOPED_ROLES.has(role)) {
    const resolvedTechGroup = techGroup ?? "";
    if (
      !resolvedTechGroup ||
      !(TECH_GROUP_OPTIONS as readonly string[]).includes(resolvedTechGroup)
    ) {
      throw new Error("技术组角色必须指定有效技术组");
    }
    return { team: "", techGroup: resolvedTechGroup };
  }

  if (GLOBAL_ROLES.has(role)) {
    if (team || techGroup) {
      throw new Error("该角色不需要指定车组或技术组");
    }
    return { team: "", techGroup: "" };
  }

  throw new Error("未知角色类型");
}

export async function assignUserRole(input: {
  openId: string;
  role: UserRoleType;
  team?: string;
  techGroup?: string;
}) {
  await requireSuperAdmin();

  const { team, techGroup } = resolveRoleScope(
    input.role,
    input.team,
    input.techGroup,
  );

  const user = await prisma.user.findUnique({ where: { openId: input.openId } });
  if (!user) {
    throw new Error("用户不存在，请先在权限管理页同步飞书通讯录");
  }

  await prisma.userRole.upsert({
    where: {
      openId_role_team_techGroup: {
        openId: input.openId,
        role: input.role,
        team,
        techGroup,
      },
    },
    update: {},
    create: {
      openId: input.openId,
      role: input.role,
      team,
      techGroup,
    },
  });

  revalidatePath("/admin");
}

export async function removeUserRole(roleId: string) {
  const session = await requireSuperAdmin();

  const record = await prisma.userRole.findUnique({ where: { id: roleId } });
  if (!record) {
    throw new Error("角色记录不存在");
  }

  if (record.role === "SUPER_ADMIN") {
    const superAdminCount = await prisma.userRole.count({
      where: { role: "SUPER_ADMIN" },
    });
    if (superAdminCount <= 1) {
      throw new Error("至少保留一名超级管理员");
    }
    if (record.openId === session.user.openId) {
      throw new Error("不能移除自己的超级管理员权限");
    }
  }

  await prisma.userRole.delete({ where: { id: roleId } });
  revalidatePath("/admin");
}
