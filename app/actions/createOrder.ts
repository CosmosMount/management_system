"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus, type PurchaseItemKind } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueOrderNotification,
} from "@/lib/notification-outbox";
import { generateOrderNo } from "@/lib/order-no";
import { attachItemReferenceImages } from "@/lib/order-item-images";
import { prisma } from "@/lib/prisma";
import { removeOrderUploads } from "@/lib/file-upload";
import { getNotificationContext } from "@/lib/request-origin";
import { routes } from "@/lib/routes";
import { requireInitiatorSignature } from "@/lib/user-signature";
import {
  assertItemImagesPresent,
  createOrderSchema,
  parseOrderFormData,
  toStoredPurchaseItem,
} from "@/lib/validations/order";

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

export async function createOrder(formData: FormData) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  await requireInitiatorSignature(session.user.openId);

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
  const status = parsed.submit
    ? OrderStatus.MANAGEMENT_REVIEW
    : OrderStatus.DRAFT;

  let order: {
    id: string;
    items: Array<{ id: string; itemKind: PurchaseItemKind }>;
  } | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const orderNo = await generateOrderNo();
      order = await prisma.$transaction(async (tx) => {
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
      break;
    } catch (err) {
      if (!isUniqueConstraintError(err) || attempt === 4) {
        throw err;
      }
    }
  }
  if (!order) {
    throw new Error("订单创建失败，请重试");
  }

  try {
    await attachItemReferenceImages(
      order.id,
      order.items.map((item) => ({ id: item.id, itemKind: item.itemKind })),
      itemImages,
      parsed.items.map((item) => item.referenceImagePath ?? null),
    );
  } catch (err) {
    await prisma.purchaseOrder.deleteMany({ where: { id: order.id } });
    await removeOrderUploads(order.id);
    throw err;
  }

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
