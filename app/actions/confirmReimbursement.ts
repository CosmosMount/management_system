"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { confirmProcurementByOpenId } from "@/lib/procurement-confirm-by-open-id";
import { routes } from "@/lib/routes";

export async function confirmReimbursement(orderId: string) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  await confirmProcurementByOpenId(session.user.openId, orderId);

  revalidatePath(routes.procurement.list);
  revalidatePath(`${routes.procurement.detail(orderId)}`);
}
