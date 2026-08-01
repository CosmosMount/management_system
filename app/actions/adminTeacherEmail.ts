"use server";

import { normalizeEmailAddress } from "@/lib/email";
import { requireSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { revalidateAdmin } from "@/lib/revalidate";

export async function updateTeacherEmail(input: {
  openId: string;
  email: string;
}) {
  await requireSuperAdmin();

  const user = await prisma.user.findFirst({
    where: {
      openId: input.openId,
      account: {
        reimbursementRoles: {
          some: { role: "TEACHER", revokedAt: null },
        },
      },
    },
    select: { id: true },
  });
  if (!user) {
    throw new Error("该用户不是指导老师，无法配置审批邮箱");
  }

  const email = normalizeEmailAddress(input.email);

  await prisma.user.update({
    where: { id: user.id },
    data: { email: email || null },
  });

  revalidateAdmin();
}
