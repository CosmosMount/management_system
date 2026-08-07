"use server";

import { ZodError } from "zod";
import { requireGlobalSuperAdministrator } from "@/lib/account-authorization";
import { normalizeEmailAddress } from "@/lib/email";
import { createDomainAuditEventTx } from "@/lib/project-management/audit";
import { prisma } from "@/lib/prisma";
import { revalidateAdmin } from "@/lib/revalidate";
import { updateTeacherEmailInputSchema } from "@/lib/validations/account-management";

export async function updateTeacherEmail(input: unknown) {
  try {
    const parsed = updateTeacherEmailInputSchema.parse(input);
    const { context } = await requireGlobalSuperAdministrator();
    const email = normalizeEmailAddress(parsed.email);

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findFirst({
        where: {
          accountId: parsed.accountId,
          account: {
            reimbursementRoles: {
              some: { role: "TEACHER", revokedAt: null },
            },
          },
        },
        select: { id: true, email: true },
      });
      if (!user) {
        throw new Error("该账号不是指导老师，无法配置审批邮箱");
      }
      if ((user.email ?? "") === email) return { email, changed: false };

      await tx.user.update({
        where: { id: user.id },
        data: { email: email || null },
      });
      await createDomainAuditEventTx(tx, {
        actorAccountId: context.accountId,
        action: "account.teacher_email.updated",
        entityType: "Account",
        entityId: parsed.accountId,
        before: { emailConfigured: Boolean(user.email) },
        after: { emailConfigured: Boolean(email) },
        reason: "超级管理员通过账号与权限后台维护指导老师审批邮箱",
      });
      return { email, changed: true };
    });

    revalidateAdmin();
    return result;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(error.issues[0]?.message ?? "提交的数据无效");
    }
    throw error;
  }
}
