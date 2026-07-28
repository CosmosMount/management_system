"use server";

import { revalidatePath } from "next/cache";
import { removeOrderUploads } from "@/lib/file-upload";
import { prisma } from "@/lib/prisma";
import { requireSuperAdmin } from "@/lib/permissions";
import { routes } from "@/lib/routes";

export async function deletePurchaseOrder(orderId: string) {
  await requireSuperAdmin();

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    select: { id: true },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  await prisma.purchaseOrder.delete({ where: { id: orderId } });
  await removeOrderUploads(orderId).catch(() => {});

  revalidatePath("/");
  revalidatePath(routes.procurement.root);
  revalidatePath(routes.procurement.list);
  revalidatePath(routes.procurement.dashboard);
  revalidatePath(routes.procurement.detail(orderId));
}
