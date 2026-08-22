"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { routes } from "@/lib/routes";
import {
  lockActiveProcurementUserTx,
  requireActiveProcurementUser,
} from "@/lib/active-account";

export async function listProcessingVendors() {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  return prisma.processingVendor.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

export async function createProcessingVendor(name: string) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }
  await requireActiveProcurementUser(session.user.openId);

  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("请输入加工商名称");
  }

  const vendor = await prisma.$transaction(async (tx) => {
    await lockActiveProcurementUserTx(tx, session.user.openId);
    return tx.processingVendor.upsert({
      where: { name: trimmed },
      update: {},
      create: { name: trimmed },
      select: { id: true, name: true },
    });
  });

  revalidatePath(routes.procurement.new);
  return vendor;
}
