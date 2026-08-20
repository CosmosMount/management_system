"use server";

import { randomUUID } from "node:crypto";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { generateOrderNo } from "@/lib/order-no";
import { prisma } from "@/lib/prisma";
import { prepareItemReferenceImages } from "@/lib/order-item-images";
import { cleanupUploadPaths } from "@/lib/upload-cleanup";
import { withActionLogging } from "@/lib/logger";
import {
  enqueueProcurementSubmitNotificationTx,
  runProcurementBudgetAlertSideEffects,
} from "@/lib/procurement-order-side-effects";
import { drainNotificationOutboxSoon } from "@/lib/notification-delivery";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProcurement } from "@/lib/revalidate";
import { requireInitiatorSignature } from "@/lib/user-signature";
import { itemKindNeedsImage } from "@/lib/purchase-item-kind";
import {
  createOrderSchema,
  parseOrderFormData,
  toStoredPurchaseItem,
} from "@/lib/validations/order";
import { parseJsonFormField } from "@/lib/validations/form-data-json";
import {
  lockActiveProcurementUserTx,
  requireActiveProcurementUser,
} from "@/lib/active-account";

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
  await requireActiveProcurementUser(session.user.openId);
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
  const payload = parseJsonFormField(formData);
  const parsed = createOrderSchema.parse(payload);
  if (parsed.submit) {
    await requireInitiatorSignature(userOpenId);
  }
  const { itemImages } = parseOrderFormData(formData);
  parsed.items.forEach((item, index) => {
    if (itemKindNeedsImage(item.itemKind) && !itemImages.has(index)) {
      throw new Error("加工费须上传对应图片");
    }
  });

  const user = await prisma.user.findUnique({
    where: { openId: userOpenId },
  });
  if (!user) {
    throw new Error("用户不存在");
  }

  const storedItems = parsed.items.map(toStoredPurchaseItem);
  const totalPrice = parsed.items.reduce((sum, item) => sum + item.lineTotal, 0);
  const status = parsed.submit ? OrderStatus.MANAGEMENT_REVIEW : OrderStatus.DRAFT;
  const orderId = randomUUID();
  const context = parsed.submit ? await getNotificationContext() : undefined;
  const preparedImages = await prepareItemReferenceImages({
    orderId,
    itemKinds: storedItems.map((item) => item.itemKind),
    itemImages,
  });
  const preparedItems = storedItems.map((item, index) => ({
    ...item,
    referenceImagePath: preparedImages.referenceImagePaths[index],
  }));
  const stagedUploadPaths = preparedImages.stagedUploadPaths;
  const cleanupStagedUploads = () =>
    cleanupUploadPaths(stagedUploadPaths, "order_create_compensation");

  let order: {
    id: string;
    team: string;
    techGroup: string;
  } | null = null;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderNo = await generateOrderNo();
      try {
        order = await prisma.$transaction(async (tx) => {
          await lockActiveProcurementUserTx(tx, userOpenId);
          const created = await tx.purchaseOrder.create({
          data: {
            id: orderId,
            orderNo,
            initiatorId: user.id,
            initiatorName: user.name,
            team: parsed.team,
            techGroup: parsed.techGroup,
            totalPrice,
            status,
            items: {
              create: preparedItems,
            },
          },
          include: { items: true },
          });
          if (parsed.submit) {
            await enqueueProcurementSubmitNotificationTx(tx, created, context!);
          }
          return created;
        });
        break;
      } catch (err) {
        if (!isUniqueConstraintError(err) || attempt === 4) {
          throw err;
        }
      }
    }
  } catch (error) {
    await cleanupStagedUploads();
    throw error;
  }
  if (!order) {
    await cleanupStagedUploads();
    throw new Error("订单创建失败，请重试");
  }

  if (status === OrderStatus.MANAGEMENT_REVIEW) {
    drainNotificationOutboxSoon();
    await runProcurementBudgetAlertSideEffects(
      order.team,
      order.techGroup,
    );
  }

  revalidateProcurement(order.id);
  return { id: order.id };
}
