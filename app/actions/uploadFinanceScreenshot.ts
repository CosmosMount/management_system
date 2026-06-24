"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { sendOrderNotification, mapOrderItems } from "@/lib/feishu";
import { getNotificationContext } from "@/lib/request-origin";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { saveUpload, uploadTypeSets } from "@/lib/file-upload";
import { prisma } from "@/lib/prisma";
import { canUploadFinanceScreenshot, getUserRoles } from "@/lib/permissions";

export async function uploadFinanceScreenshot(formData: FormData) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const userRoles = await getUserRoles(session.user.openId);
  const orderId = String(formData.get("orderId") ?? "");

  if (!orderId) {
    throw new Error("参数无效");
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  const scope = { team: order.team, techGroup: order.techGroup };
  if (!canUploadFinanceScreenshot(order.status, userRoles, scope)) {
    throw new Error("无报销操作权限");
  }

  const screenshot = formData.get("screenshot");
  if (!(screenshot instanceof File) || screenshot.size === 0) {
    throw new Error("请上传报销截图");
  }

  const screenshotPath = await saveUpload(
    orderId,
    screenshot,
    "screenshot",
    uploadTypeSets.screenshot,
  );

  const updated = await prisma.purchaseOrder.update({
    where: { id: orderId },
    data: {
      screenshotPath,
      status: OrderStatus.PENDING_APPLICANT_CONFIRM,
      ...stepTimerResetFields(),
    },
  });

  await sendOrderNotification({
    id: updated.id,
    orderNo: updated.orderNo,
    initiatorName: updated.initiatorName,
    totalPrice: updated.totalPrice,
    status: updated.status,
    team: updated.team,
    techGroup: updated.techGroup,
    items: mapOrderItems(order.items),
  }, await getNotificationContext()).catch((err) => {
    console.error("[uploadFinanceScreenshot] 飞书通知失败:", err);
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  return updated;
}
