"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueOrderNotificationTx,
  orderNotificationEventKey,
} from "@/lib/notification-outbox";
import { getNotificationContext } from "@/lib/request-origin";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import {
  removeUploadByPublicPath,
  saveUpload,
  uploadTypeSets,
} from "@/lib/file-upload";
import { prisma } from "@/lib/prisma";
import { canUploadFinanceScreenshot, getUserRoles } from "@/lib/permissions";
import { routes } from "@/lib/routes";

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

  const context = await getNotificationContext();
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const locked = await tx.purchaseOrder.updateMany({
        where: { id: orderId, status: order.status },
        data: {
          screenshotPath,
          status: OrderStatus.PENDING_APPLICANT_CONFIRM,
          ...stepTimerResetFields(),
        },
      });
      if (locked.count !== 1) {
        throw new Error("订单状态已更新，请刷新后重试");
      }
      const record = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: orderId },
      });
      await enqueueOrderNotificationTx(
        tx,
        orderNotificationEventKey(record),
        {
          id: record.id,
          orderNo: record.orderNo,
          initiatorName: record.initiatorName,
          totalPrice: record.totalPrice,
          status: record.status,
          team: record.team,
          techGroup: record.techGroup,
          items: mapOrderItems(order.items),
        },
        context,
      );
      return record;
    });
  } catch (err) {
    await removeUploadByPublicPath(screenshotPath);
    throw err;
  }
  drainNotificationOutboxSoon();

  revalidatePath(routes.procurement.list);
  revalidatePath(`${routes.procurement.detail(orderId)}`);
  return updated;
}
