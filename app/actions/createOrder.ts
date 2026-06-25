"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueOrderNotification,
} from "@/lib/notification-outbox";
import { generateOrderNo } from "@/lib/order-no";
import { attachItemReferenceImages } from "@/lib/order-item-images";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { routes } from "@/lib/routes";
import {
  assertItemImagesPresent,
  createOrderSchema,
  parseOrderFormData,
  toStoredPurchaseItem,
} from "@/lib/validations/order";

export async function createOrder(formData: FormData) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const payload = JSON.parse(String(formData.get("payload") ?? "{}"));
  const parsed = createOrderSchema.parse(payload);
  const { itemImages } = parseOrderFormData(formData);
  assertItemImagesPresent(parsed.items, itemImages);

  const user = await prisma.user.findUnique({
    where: { openId: session.user.openId },
  });
  if (!user) {
    throw new Error("用户不存在");
  }

  const storedItems = parsed.items.map(toStoredPurchaseItem);
  const totalPrice = parsed.items.reduce((sum, item) => sum + item.lineTotal, 0);
  const orderNo = await generateOrderNo();
  const status = parsed.submit
    ? OrderStatus.MANAGEMENT_REVIEW
    : OrderStatus.DRAFT;

  const order = await prisma.$transaction(async (tx) => {
    return tx.purchaseOrder.create({
      data: {
        orderNo,
        initiatorId: user.id,
        initiatorName: user.name,
        team: parsed.team,
        techGroup: parsed.techGroup,
        totalPrice,
        status,
        items: {
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
    throw new Error("订单创建失败");
  }

  if (status === OrderStatus.MANAGEMENT_REVIEW) {
    await enqueueOrderNotification(
      `procurement:order:${refreshed.id}:${refreshed.status}:${refreshed.updatedAt.toISOString()}`,
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
    );
    drainNotificationOutboxSoon();
  }

  revalidatePath("/");
  revalidatePath(routes.procurement.root);
  revalidatePath(routes.procurement.list);
  revalidatePath(routes.procurement.dashboard);
  return refreshed;
}
