"use server";

import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import {
  assertExistingItemImagesBelongToOrder,
  prepareItemReferenceImages,
} from "@/lib/order-item-images";
import { prisma } from "@/lib/prisma";
import { canEditDraftOrder } from "@/lib/permissions";
import { withActionLogging } from "@/lib/logger";
import { procurementResubmitFields } from "@/lib/procurement-order-draft";
import {
  enqueueProcurementSubmitNotificationTx,
  runProcurementBudgetAlertSideEffects,
} from "@/lib/procurement-order-side-effects";
import { drainNotificationOutboxSoon } from "@/lib/notification-delivery";
import { getNotificationContext } from "@/lib/request-origin";
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
import { parseJsonFormField } from "@/lib/validations/form-data-json";
import { cleanupUploadPaths } from "@/lib/upload-cleanup";

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
  const payload = parseJsonFormField(formData);
  const parsed = updateOrderSchema.parse(payload);
  const { itemImages } = parseOrderFormData(formData);
  assertItemImagesPresent(parsed.items, itemImages);

  if (parsed.submit) {
    await requireInitiatorSignature(userOpenId);
  }

  const currentOrder = await requireDraftOrder(parsed.orderId, userOpenId);
  await assertExistingItemImagesBelongToOrder(
    parsed.orderId,
    currentOrder.items.map((item) => item.referenceImagePath),
    parsed.items.map((item) => item.referenceImagePath),
  );

  const storedItems = parsed.items.map(toStoredPurchaseItem);
  const totalPrice = parsed.items.reduce((sum, item) => sum + item.lineTotal, 0);
  const prepared = await prepareItemReferenceImages({
    orderId: parsed.orderId,
    itemKinds: storedItems.map((item) => item.itemKind),
    itemImages,
    existingPaths: parsed.items.map((item) => item.referenceImagePath),
  });
  const preparedItems = storedItems.map((item, index) => ({
    ...item,
    referenceImagePath: prepared.referenceImagePaths[index],
  }));
  const context = parsed.submit ? await getNotificationContext() : undefined;
  let refreshed;
  try {
    refreshed = await prisma.$transaction(async (tx) => {
      const changed = await tx.purchaseOrder.updateMany({
        where: {
          id: parsed.orderId,
          status: OrderStatus.DRAFT,
          updatedAt: new Date(parsed.expectedUpdatedAt),
          initiator: { openId: userOpenId },
        },
        data: {
          team: parsed.team,
          techGroup: parsed.techGroup,
          totalPrice,
          ...(parsed.submit
            ? procurementResubmitFields()
            : { status: OrderStatus.DRAFT }),
        },
      });
      if (changed.count !== 1) {
        throw new Error("订单状态已更新，请刷新后重试");
      }
      await tx.purchaseItem.deleteMany({ where: { orderId: parsed.orderId } });
      await tx.purchaseItem.createMany({
        data: preparedItems.map((item) => ({ ...item, orderId: parsed.orderId })),
      });
      const updated = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: parsed.orderId },
        include: { items: true },
      });
      if (parsed.submit) {
        await enqueueProcurementSubmitNotificationTx(tx, updated, context!);
      }
      return updated;
    });
  } catch (error) {
    await cleanupUploadPaths(
      prepared.stagedUploadPaths,
      "order_update_transaction_compensation",
    );
    throw error;
  }

  const retainedPaths = new Set(
    prepared.referenceImagePaths.filter((value): value is string => !!value),
  );
  const replacedPaths = currentOrder.items
    .map((item) => item.referenceImagePath)
    .filter(
      (value): value is string => !!value && !retainedPaths.has(value),
    );
  await cleanupUploadPaths(replacedPaths, "order_update_replaced_images");

  if (parsed.submit) {
    drainNotificationOutboxSoon();
    await runProcurementBudgetAlertSideEffects(
      refreshed.team,
      refreshed.techGroup,
    );
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

  const context = await getNotificationContext();
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
    const submitted = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
    await enqueueProcurementSubmitNotificationTx(tx, submitted, context);
    return submitted;
  });

  drainNotificationOutboxSoon();
  await runProcurementBudgetAlertSideEffects(updated.team, updated.techGroup);

  revalidateProcurement(orderId);
  return { id: updated.id };
}
