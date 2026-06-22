"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { sendFeishuCard } from "@/lib/feishu";
import { generateOrderNo } from "@/lib/order-no";
import { prisma } from "@/lib/prisma";
import {
  createOrderSchema,
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

  const totalPrice = parsed.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0,
  );
  const orderNo = await generateOrderNo();
  const status = parsed.submit ? OrderStatus.TECH_REVIEW : OrderStatus.DRAFT;

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
          create: parsed.items.map((item) => ({
            name: item.name,
            spec: item.spec,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        },
      },
      include: { items: true },
    });
  });

  if (status === OrderStatus.TECH_REVIEW) {
    await sendFeishuCard({
      id: order.id,
      orderNo: order.orderNo,
      initiatorName: order.initiatorName,
      totalPrice: order.totalPrice,
      status: order.status,
    }).catch((err) => {
      console.error("[createOrder] 飞书通知失败:", err);
    });
  }

  revalidatePath("/orders");
  return order;
}
