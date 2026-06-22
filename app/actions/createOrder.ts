"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { sendOrderNotification } from "@/lib/feishu";
import { generateOrderNo } from "@/lib/order-no";
import { prisma } from "@/lib/prisma";
import {
  createOrderSchema,
  toStoredPurchaseItem,
  type CreateOrderInput,
} from "@/lib/validations/order";

export async function createOrder(input: CreateOrderInput) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const parsed = createOrderSchema.parse(input);
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

  if (status === OrderStatus.MANAGEMENT_REVIEW) {
    await sendOrderNotification({
      id: order.id,
      orderNo: order.orderNo,
      initiatorName: order.initiatorName,
      totalPrice: order.totalPrice,
      status: order.status,
      team: order.team,
      techGroup: order.techGroup,
    }).catch((err) => {
      console.error("[createOrder] 飞书通知失败:", err);
    });
  }

  revalidatePath("/");
  revalidatePath("/orders");
  revalidatePath("/dashboard");
  return order;
}
