"use server";

import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
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
  const orderNo = await generateWorkshopOrderNo();

  const order = await prisma.$transaction(async (tx) => {
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
            quantity: item.quantity,
            unitPrice: item.lineTotal / item.quantity,
          })),
        },
      },
      include: { items: true },
    });
  });

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
