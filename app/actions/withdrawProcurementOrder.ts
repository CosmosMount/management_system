"use server";

import { auth } from "@/lib/auth";
import { ensureProcurementOrderEditableDraft } from "@/lib/procurement-order-draft";
import { revalidateProcurement } from "@/lib/revalidate";

export async function withdrawProcurementOrderForEdit(orderId: string) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const order = await ensureProcurementOrderEditableDraft(
    orderId,
    session.user.openId,
  );
  revalidateProcurement(orderId);
  return { id: order.id };
}
