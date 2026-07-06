"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { withActionLogging } from "@/lib/logger";
import { confirmProcurementByOpenId } from "@/lib/procurement-confirm-by-open-id";
import { routes } from "@/lib/routes";

export async function confirmReimbursement(orderId: string) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }
  return withActionLogging(
    {
      event: "procurement.reimbursement.confirm",
      module: "procurement",
      action: "confirmReimbursement",
      actorOpenId: session.user.openId,
      actorName: session.user.name ?? "",
      entityType: "PurchaseOrder",
      entityId: orderId,
    },
    async () => confirmReimbursementLogged(orderId, session.user.openId),
  );
}

async function confirmReimbursementLogged(orderId: string, userOpenId: string) {
  await confirmProcurementByOpenId(userOpenId, orderId);

  revalidatePath(routes.procurement.list);
  revalidatePath(`${routes.procurement.detail(orderId)}`);
}
