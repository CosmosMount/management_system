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

  const teacherRole = await prisma.userRole.findFirst({
    where: {
      openId: input.openId,
      role: "TEACHER",
    },
    select: { id: true },
  });
  if (!teacherRole) {
    throw new Error("该用户不是指导老师，无法配置审批邮箱");
  }

  const user = await prisma.user.findUnique({
    where: { openId: input.openId },
    select: { id: true },
  });
  if (!user) {
    throw new Error("用户不存在");
  }

  const email = normalizeEmailAddress(input.email);

  await prisma.user.update({
    where: { openId: input.openId },
    data: { email: email || null },
  });

  revalidateAdmin();
}
