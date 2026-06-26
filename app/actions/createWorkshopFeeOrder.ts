"use server";

import { auth } from "@/lib/auth";
import { OrderStatus, type PurchaseItemKind } from "@prisma/client";
import { attachItemReferenceImages } from "@/lib/order-item-images";
import { removeOrderUploads } from "@/lib/file-upload";
import { prisma } from "@/lib/prisma";
import { revalidateProcurement } from "@/lib/revalidate";
import {
  assertWorkshopFeeImages,
  createWorkshopFeeSchema,
  parseWorkshopFeeFormData,
} from "@/lib/validations/workshop-fee";
import { generateWorkshopOrderNo } from "@/lib/workshop-order-no";

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

  const payload = JSON.parse(String(formData.get("payload") ?? "{}"));
  const parsed = createWorkshopFeeSchema.parse(payload);
  const { itemImages } = parseWorkshopFeeFormData(formData);
  assertWorkshopFeeImages(parsed.items, itemImages);

  const user = await prisma.user.findUnique({
    where: { openId: session.user.openId },
  });
  if (!user) {
    throw new Error("用户不存在");
  }

  const totalPrice = parsed.items.reduce((sum, item) => sum + item.lineTotal, 0);

  let order: {
    id: string;
    items: Array<{ id: string; itemKind: PurchaseItemKind }>;
  } | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const orderNo = await generateWorkshopOrderNo();
      order = await prisma.$transaction(async (tx) => {
        return tx.purchaseOrder.create({
          data: {
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
            items: {
              create: parsed.items.map((item) => ({
                name: item.name,
                spec: item.spec,
                itemKind: "PROCESSING_FEE",
                purchaseLink: "",
                processingVendor: item.processingVendor,
                quantity: item.quantity,
                unitPrice: item.lineTotal / item.quantity,
              })),
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
      parsed.items.map(() => null),
    );
  } catch (err) {
    await prisma.purchaseOrder.deleteMany({ where: { id: order.id } });
    await removeOrderUploads(order.id);
    throw err;
  }

  revalidateProcurement(order.id);

  return order;
}
