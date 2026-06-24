"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { sendOrderNotification, mapOrderItems } from "@/lib/feishu";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { attachItemReferenceImages } from "@/lib/order-item-images";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { canEditDraftOrder } from "@/lib/permissions";
import { routes } from "@/lib/routes";
import {
  assertItemImagesPresent,
  createOrderSchema,
  parseOrderFormData,
  toOrderFormInput,
  toStoredPurchaseItem,
  updateOrderSchema,
} from "@/lib/validations/order";

async function requireDraftOrder(orderId: string) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      initiator: { select: { openId: true } },
    },
  });
  if (!order) {
    throw new Error("订单不存在");
  }
  if (
    !canEditDraftOrder(
      order.status,
      session.user.openId,
      order.initiator.openId,
    )
  ) {
    throw new Error("无权限操作该草稿");
  }

  return order;
}

export async function updateOrder(formData: FormData) {
  const payload = JSON.parse(String(formData.get("payload") ?? "{}"));
  const parsed = updateOrderSchema.parse(payload);
  const { itemImages } = parseOrderFormData(formData);
  assertItemImagesPresent(parsed.items, itemImages);

  await requireDraftOrder(parsed.orderId);

  const storedItems = parsed.items.map(toStoredPurchaseItem);
  const totalPrice = parsed.items.reduce((sum, item) => sum + item.lineTotal, 0);
  const nextStatus = parsed.submit
    ? OrderStatus.MANAGEMENT_REVIEW
    : OrderStatus.DRAFT;

  const order = await prisma.$transaction(async (tx) => {
    return tx.purchaseOrder.update({
      where: { id: parsed.orderId },
      data: {
        team: parsed.team,
        techGroup: parsed.techGroup,
        totalPrice,
        status: nextStatus,
        ...(parsed.submit ? stepTimerResetFields() : {}),
        items: {
          deleteMany: {},
          create: storedItems,
        },
      },
      include: { items: true },
    });
  });

  await attachItemReferenceImages(
    order.id,
    order.items.map((item) => ({ id: item.id, itemKind: item.itemKind })),
    itemImages,
    parsed.items.map((item) => item.referenceImagePath ?? null),
  );

  const refreshed = await prisma.purchaseOrder.findUnique({
    where: { id: order.id },
    include: { items: true },
  });
  if (!refreshed) {
    throw new Error("订单更新失败");
  }

  if (nextStatus === OrderStatus.MANAGEMENT_REVIEW) {
    await sendOrderNotification(
      {
        id: refreshed.id,
        orderNo: refreshed.orderNo,
        initiatorName: refreshed.initiatorName,
        totalPrice: refreshed.totalPrice,
        status: refreshed.status,
        team: refreshed.team,
        techGroup: refreshed.techGroup,
        items: mapOrderItems(refreshed.items),
      },
      await getNotificationContext(),
    ).catch((err) => {
      console.error("[updateOrder] 飞书通知失败:", err);
    });
  }

  revalidatePath("/");
  revalidatePath(routes.procurement.list);
  revalidatePath(routes.procurement.dashboard);
  revalidatePath(`${routes.procurement.detail(order.id)}`);
  revalidatePath(`${routes.procurement.edit(order.id)}`);
  return refreshed;
}

export async function submitDraftOrder(orderId: string) {
  const order = await requireDraftOrder(orderId);
  const formInput = toOrderFormInput(order);
  createOrderSchema.parse({ ...formInput, submit: true });
  assertItemImagesPresent(formInput.items, new Map());

  const updated = await prisma.purchaseOrder.update({
    where: { id: orderId },
    data: {
      status: OrderStatus.MANAGEMENT_REVIEW,
      ...stepTimerResetFields(),
    },
    include: { items: true },
  });

  await sendOrderNotification(
    {
      id: updated.id,
      orderNo: updated.orderNo,
      initiatorName: updated.initiatorName,
      totalPrice: updated.totalPrice,
      status: updated.status,
      team: updated.team,
      techGroup: updated.techGroup,
      items: mapOrderItems(updated.items),
    },
    await getNotificationContext(),
  ).catch((err) => {
    console.error("[submitDraftOrder] 飞书通知失败:", err);
  });

  revalidatePath("/");
  revalidatePath(routes.procurement.list);
  revalidatePath(routes.procurement.dashboard);
  revalidatePath(`${routes.procurement.detail(orderId)}`);
  revalidatePath(`${routes.procurement.edit(orderId)}`);
  return updated;
}
