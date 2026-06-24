"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { sendOrderNotification, mapOrderItems } from "@/lib/feishu";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { prisma } from "@/lib/prisma";
import { getNotificationContext } from "@/lib/request-origin";
import { routes } from "@/lib/routes";
import {
  canApproveTeamManagement,
  canApproveTechGroupManagement,
  getUserRoles,
} from "@/lib/permissions";
import { requireApproverSignature } from "@/lib/user-signature";

export async function approveManagementReview(orderId: string) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const userRoles = await getUserRoles(session.user.openId);
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) {
    throw new Error("订单不存在");
  }
  if (order.status !== OrderStatus.MANAGEMENT_REVIEW) {
    throw new Error("当前状态不允许此操作");
  }

  const scope = { team: order.team, techGroup: order.techGroup };
  const state = {
    teamApproved: order.teamApproved,
    techGroupApproved: order.techGroupApproved,
  };

  const canTeam = canApproveTeamManagement(userRoles, scope, state);
  const canTech = canApproveTechGroupManagement(userRoles, scope, state);

  if (!canTeam && !canTech) {
    throw new Error("无操作权限或已审核");
  }

  await requireApproverSignature(session.user.openId);

  const teamApproved = order.teamApproved || canTeam;
  const techGroupApproved = order.techGroupApproved || canTech;

  const allApproved = teamApproved && techGroupApproved;

  const updated = await prisma.purchaseOrder.update({
    where: { id: orderId },
    data: {
      teamApproved,
      techGroupApproved,
      ...stepTimerResetFields(),
      ...(allApproved ? { status: OrderStatus.TEACHER_REVIEW } : {}),
    },
  });

  if (allApproved) {
    await sendOrderNotification({
      id: updated.id,
      orderNo: updated.orderNo,
      initiatorName: updated.initiatorName,
      totalPrice: updated.totalPrice,
      status: updated.status,
      team: updated.team,
      techGroup: updated.techGroup,
      items: mapOrderItems(order.items),
    }, await getNotificationContext()).catch((err) => {
      console.error("[approveManagementReview] 飞书通知失败:", err);
    });
  }

  revalidatePath(routes.procurement.list);
  revalidatePath(`${routes.procurement.detail(orderId)}`);
  return updated;
}
