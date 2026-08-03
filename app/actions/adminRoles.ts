"use server";

import type { UserRoleType } from "@prisma/client";
import { z, ZodError } from "zod";
import {
  assignReimbursementRole,
  grantAccountRole,
  revokeAccountRole,
  revokeReimbursementRole,
} from "@/lib/account-management";
import { requireGlobalSuperAdministrator } from "@/lib/account-authorization";
import { prisma } from "@/lib/prisma";
import { revalidateAdmin } from "@/lib/revalidate";
import {
  assignReimbursementRoleInputSchema,
  grantAccountRoleInputSchema,
  revokeRoleInputSchema,
} from "@/lib/validations/account-management";

function inputError(error: unknown): never {
  if (error instanceof ZodError) {
    throw new Error(error.issues[0]?.message ?? "提交的数据无效");
  }
  throw error;
}

const compatibilityUserRoleInputSchema = z.object({
  openId: z.string().trim().min(1, "用户参数无效"),
  role: z.enum([
    "SUPER_ADMIN",
    "TEAM_ADMIN",
    "TECH_GROUP_ADMIN",
    "TEACHER",
    "FINANCE",
  ]),
  team: z.string().trim().optional().default(""),
  techGroup: z.string().trim().optional().default(""),
});

export async function grantProjectSystemRole(input: {
  targetAccountId: string;
  role: "SUPER_ADMINISTRATOR" | "PROJECT_ADMINISTRATOR";
  team?: string;
  techGroup?: string;
}) {
  try {
    const parsed = grantAccountRoleInputSchema.parse(input);
    const { context } = await requireGlobalSuperAdministrator();
    const result = await grantAccountRole(context.accountId, parsed);
    revalidateAdmin();
    return { changed: result.changed };
  } catch (error) {
    inputError(error);
  }
}

export async function revokeProjectSystemRole(input: {
  assignmentId: string;
}) {
  try {
    const parsed = revokeRoleInputSchema.parse(input);
    const { context } = await requireGlobalSuperAdministrator();
    const result = await revokeAccountRole(
      context.accountId,
      parsed.assignmentId,
    );
    revalidateAdmin();
    return { changed: result.changed };
  } catch (error) {
    inputError(error);
  }
}

export async function assignAccountReimbursementRole(input: {
  targetAccountId: string;
  role: "TEAM_ADMIN" | "TECH_GROUP_ADMIN" | "TEACHER" | "FINANCE";
  team?: string;
  techGroup?: string;
}) {
  try {
    const parsed = assignReimbursementRoleInputSchema.parse(input);
    const { context } = await requireGlobalSuperAdministrator();
    const result = await assignReimbursementRole(context.accountId, parsed);
    revalidateAdmin();
    return { changed: result.changed };
  } catch (error) {
    inputError(error);
  }
}

export async function revokeAccountReimbursementRole(input: {
  assignmentId: string;
}) {
  try {
    const parsed = revokeRoleInputSchema.parse(input);
    const { context } = await requireGlobalSuperAdministrator();
    const result = await revokeReimbursementRole(
      context.accountId,
      parsed.assignmentId,
    );
    revalidateAdmin();
    return { changed: result.changed };
  } catch (error) {
    inputError(error);
  }
}

/** Compatibility entry point for the existing reimbursement-role UI. */
export async function assignUserRole(input: {
  openId: string;
  role: UserRoleType;
  team?: string;
  techGroup?: string;
}) {
  try {
    const { context } = await requireGlobalSuperAdministrator();
    const parsedInput = compatibilityUserRoleInputSchema.parse(input);
    const user = await prisma.user.findUnique({
      where: { openId: parsedInput.openId },
      select: { accountId: true },
    });
    if (!user?.accountId) {
      throw new Error("用户缺少统一账号，请先同步飞书通讯录");
    }
    if (parsedInput.role === "SUPER_ADMIN") {
      const parsed = grantAccountRoleInputSchema.parse({
        targetAccountId: user.accountId,
        role: "SUPER_ADMINISTRATOR",
      });
      const result = await grantAccountRole(context.accountId, parsed);
      revalidateAdmin();
      return { changed: result.changed };
    }
    const parsed = assignReimbursementRoleInputSchema.parse({
      targetAccountId: user.accountId,
      role: parsedInput.role,
      team: parsedInput.team,
      techGroup: parsedInput.techGroup,
    });
    const result = await assignReimbursementRole(context.accountId, parsed);
    revalidateAdmin();
    return { changed: result.changed };
  } catch (error) {
    inputError(error);
  }
}

/** Compatibility entry point for the existing reimbursement-role UI. */
export async function removeUserRole(roleId: string) {
  return revokeAccountReimbursementRole({ assignmentId: roleId });
}
