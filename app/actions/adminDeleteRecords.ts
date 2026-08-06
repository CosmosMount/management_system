"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireSuperAdmin } from "@/lib/permissions";
import { routes } from "@/lib/routes";
import { cleanupUploadPaths } from "@/lib/upload-cleanup";

export async function deletePurchaseOrder(orderId: string) {
  await requireSuperAdmin();

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    select: { id: true },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  const assets = await prisma.fileAsset.findMany({
    where: { orderId },
    select: { publicPath: true },
  });
  await prisma.purchaseOrder.delete({ where: { id: orderId } });
  await cleanupUploadPaths(
    assets.map((asset) => asset.publicPath),
    "admin_order_delete",
  );

  revalidatePath("/");
  revalidatePath(routes.procurement.root);
  revalidatePath(routes.procurement.list);
  revalidatePath(routes.procurement.dashboard);
  revalidatePath(routes.procurement.detail(orderId));
}
