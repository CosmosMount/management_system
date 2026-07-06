"use server";

import { auth } from "@/lib/auth";
import { OrderStatus, type PurchaseItemKind } from "@prisma/client";
import { generateOrderNo } from "@/lib/order-no";
import { attachItemReferenceImages } from "@/lib/order-item-images";
import { prisma } from "@/lib/prisma";
import { removeOrderUploads } from "@/lib/file-upload";
import { withActionLogging } from "@/lib/logger";
import { runProcurementSubmitSideEffects } from "@/lib/procurement-order-side-effects";
import { revalidateProcurement } from "@/lib/revalidate";
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
  return withActionLogging(
    {
      event: "procurement.order.create",
      module: "procurement",
      action: "createOrder",
      actorOpenId: session.user.openId,
      actorName: session.user.name ?? "",
      entityType: "PurchaseOrder",
    },
    async () => createOrderLogged(formData, session.user.openId),
  );
}

async function createOrderLogged(formData: FormData, userOpenId: string) {
  const payload = JSON.parse(String(formData.get("payload") ?? "{}"));
  const parsed = createOrderSchema.parse(payload);
  if (parsed.submit) {
    await requireInitiatorSignature(userOpenId);
  }
  const { itemImages } = parseOrderFormData(formData);
  assertItemImagesPresent(parsed.items, itemImages);

  const user = await prisma.user.findUnique({
    where: { openId: userOpenId },
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
            ...(parsed.submit
              ? { statusEnteredAt: new Date(), lastReminderAt: null }
              : {}),
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
    await runProcurementSubmitSideEffects(refreshed);
  }

  revalidateProcurement(refreshed.id);
  return { id: refreshed.id };
}
