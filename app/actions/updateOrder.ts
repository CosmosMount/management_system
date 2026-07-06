"use server";

import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { attachItemReferenceImages } from "@/lib/order-item-images";
import { prisma } from "@/lib/prisma";
import { canEditDraftOrder } from "@/lib/permissions";
import { withActionLogging } from "@/lib/logger";
import {
  procurementResubmitFields,
} from "@/lib/procurement-order-draft";
import { runProcurementSubmitSideEffects } from "@/lib/procurement-order-side-effects";
import { revalidateProcurement } from "@/lib/revalidate";
import { requireInitiatorSignature } from "@/lib/user-signature";
import {
  assertItemImagesPresent,
  createOrderSchema,
  parseOrderFormData,
  toOrderFormInput,
  toStoredPurchaseItem,
  updateOrderSchema,
} from "@/lib/validations/order";

async function requireDraftOrder(orderId: string, userOpenId: string) {
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
      userOpenId,
      order.initiator.openId,
    )
  ) {
    throw new Error("无权限操作该草稿");
  }

  return order;
}

export async function updateOrder(formData: FormData) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }
  return withActionLogging(
    {
      event: "procurement.order.update",
      module: "procurement",
      action: "updateOrder",
      actorOpenId: session.user.openId,
      actorName: session.user.name ?? "",
      entityType: "PurchaseOrder",
    },
    async () => updateOrderLogged(formData, session.user.openId),
  );
}

async function updateOrderLogged(formData: FormData, userOpenId: string) {
  const payload = JSON.parse(String(formData.get("payload") ?? "{}"));
  const parsed = updateOrderSchema.parse(payload);
  const { itemImages } = parseOrderFormData(formData);
  assertItemImagesPresent(parsed.items, itemImages);

  if (parsed.submit) {
    await requireInitiatorSignature(userOpenId);
  }

  await requireDraftOrder(parsed.orderId, userOpenId);

  const storedItems = parsed.items.map(toStoredPurchaseItem);
  const totalPrice = parsed.items.reduce((sum, item) => sum + item.lineTotal, 0);

  const order = await prisma.$transaction(async (tx) => {
    const updated = await tx.purchaseOrder.updateMany({
      where: {
        id: parsed.orderId,
        status: OrderStatus.DRAFT,
        initiator: { openId: userOpenId },
      },
      data: {
        team: parsed.team,
        techGroup: parsed.techGroup,
        totalPrice,
        ...(parsed.submit ? procurementResubmitFields() : { status: OrderStatus.DRAFT }),
      },
    });
    if (updated.count !== 1) {
      throw new Error("订单状态已更新，请刷新后重试");
    }

    return tx.purchaseOrder.update({
      where: { id: parsed.orderId },
      data: {
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

  if (parsed.submit) {
    await runProcurementSubmitSideEffects(refreshed);
  }

  revalidateProcurement(refreshed.id);
  return { id: refreshed.id };
}

export async function submitDraftOrder(orderId: string) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }
  return withActionLogging(
    {
      event: "procurement.order.submit_draft",
      module: "procurement",
      action: "submitDraftOrder",
      actorOpenId: session.user.openId,
      actorName: session.user.name ?? "",
      entityType: "PurchaseOrder",
      entityId: orderId,
    },
    async () => submitDraftOrderLogged(orderId, session.user.openId),
  );
}

async function submitDraftOrderLogged(orderId: string, userOpenId: string) {
  await requireInitiatorSignature(userOpenId);

  const order = await requireDraftOrder(orderId, userOpenId);
  const formInput = toOrderFormInput(order);
  createOrderSchema.parse({ ...formInput, submit: true });
  assertItemImagesPresent(formInput.items, new Map());

  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.purchaseOrder.updateMany({
      where: {
        id: orderId,
        status: OrderStatus.DRAFT,
        initiator: { openId: userOpenId },
      },
      data: procurementResubmitFields(),
    });
    if (changed.count !== 1) {
      throw new Error("订单状态已更新，请刷新后重试");
    }
    return tx.purchaseOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
  });

  await runProcurementSubmitSideEffects(updated);

  revalidateProcurement(orderId);
  return { id: updated.id };
}
