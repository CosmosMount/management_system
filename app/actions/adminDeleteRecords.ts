"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/permissions";
import { deletePurchaseOrderAsSuperAdministrator } from "@/lib/procurement-order-deletion";
import { routes } from "@/lib/routes";
import { cleanupUploadPaths } from "@/lib/upload-cleanup";

export async function deletePurchaseOrder(orderId: string) {
  const session = await requireSuperAdmin();
  const assetPaths = await deletePurchaseOrderAsSuperAdministrator(
    session.user.openId,
    orderId,
  );
  await cleanupUploadPaths(assetPaths, "admin_order_delete");

  revalidatePath("/");
  revalidatePath(routes.procurement.root);
  revalidatePath(routes.procurement.list);
  revalidatePath(routes.procurement.dashboard);
  revalidatePath(routes.procurement.detail(orderId));
}
