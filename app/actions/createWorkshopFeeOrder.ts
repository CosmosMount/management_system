"use server";

import { auth } from "@/lib/auth";
import { randomUUID } from "node:crypto";
import { OrderStatus } from "@prisma/client";
import { prepareItemReferenceImages } from "@/lib/order-item-images";
import { cleanupUploadPaths } from "@/lib/upload-cleanup";
import { withActionLogging } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { revalidateProcurement } from "@/lib/revalidate";
import { runProcurementBudgetAlertSideEffects } from "@/lib/procurement-order-side-effects";
import {
  assertWorkshopFeeImages,
  createWorkshopFeeSchema,
  parseWorkshopFeeFormData,
} from "@/lib/validations/workshop-fee";
import { generateWorkshopOrderNo } from "@/lib/workshop-order-no";
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

export async function createWorkshopFeeOrder(formData: FormData) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }
  await requireActiveProcurementUser(session.user.openId);
  return withActionLogging(
    {
      event: "procurement.workshop_fee.create",
      module: "procurement",
      action: "createWorkshopFeeOrder",
      actorOpenId: session.user.openId,
      actorName: session.user.name ?? "",
      entityType: "PurchaseOrder",
    },
    async () => createWorkshopFeeOrderLogged(formData, session.user.openId),
  );
}

async function createWorkshopFeeOrderLogged(formData: FormData, userOpenId: string) {
  const payload = parseJsonFormField(formData);
  const parsed = createWorkshopFeeSchema.parse(payload);
  const { itemImages } = parseWorkshopFeeFormData(formData);
  assertWorkshopFeeImages(parsed.items, itemImages);

  const user = await prisma.user.findUnique({
    where: { openId: userOpenId },
  });
  if (!user) {
    throw new Error("用户不存在");
  }

  const totalPrice = parsed.items.reduce((sum, item) => sum + item.lineTotal, 0);

  const orderId = randomUUID();
  const preparedImages = await prepareItemReferenceImages({
    orderId,
    itemKinds: parsed.items.map(() => "PROCESSING_FEE"),
    itemImages,
  });
  let order: { id: string } | null = null;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderNo = await generateWorkshopOrderNo();
      try {
        order = await prisma.$transaction(async (tx) => {
          await lockActiveProcurementUserTx(tx, userOpenId);
          return tx.purchaseOrder.create({
          data: {
            id: orderId,
            orderNo,
            initiatorId: user.id,
            initiatorName: user.name,
            team: parsed.team,
            techGroup: parsed.techGroup,
            totalPrice,
            status: OrderStatus.COMPLETED,
            isWorkshopFee: true,
            teamApproved: true,
            techGroupApproved: true,
            items: { create: parsed.items.map((item, index) => ({
                name: item.name,
                spec: item.spec,
                itemKind: "PROCESSING_FEE",
                purchaseLink: "",
                processingVendor: item.processingVendor,
                quantity: item.quantity,
                unitPrice: item.lineTotal / item.quantity,
                referenceImagePath: preparedImages.referenceImagePaths[index],
              })),
            },
          },
          });
        });
        break;
      } catch (err) {
        if (!isUniqueConstraintError(err) || attempt === 4) throw err;
      }
    }
  } catch (error) {
    await cleanupUploadPaths(
      preparedImages.stagedUploadPaths,
      "workshop_order_create_compensation",
    );
    throw error;
  }
  if (!order) {
    await cleanupUploadPaths(
      preparedImages.stagedUploadPaths,
      "workshop_order_create_compensation",
    );
    throw new Error("订单创建失败，请重试");
  }

  revalidateProcurement(order.id);

  await runProcurementBudgetAlertSideEffects(parsed.team, parsed.techGroup);

  return { id: order.id };
}
