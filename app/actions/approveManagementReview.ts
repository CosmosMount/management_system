"use server";

import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueOrderNotification,
} from "@/lib/notification-outbox";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { prisma } from "@/lib/prisma";
import { revalidateProcurement } from "@/lib/revalidate";
import { getNotificationContext } from "@/lib/request-origin";
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

  const { updated, advancedToTeacherReview } = await prisma.$transaction(
    async (tx) => {
      const approvalTargets = [
        ...(canTeam ? [{ teamApproved: false }] : []),
        ...(canTech ? [{ techGroupApproved: false }] : []),
      ];

      const approved = await tx.purchaseOrder.updateMany({
        where: {
          id: orderId,
          status: OrderStatus.MANAGEMENT_REVIEW,
          OR: approvalTargets,
        },
        data: {
          ...(canTeam ? { teamApproved: true } : {}),
          ...(canTech ? { techGroupApproved: true } : {}),
          ...stepTimerResetFields(),
        },
      });
      if (approved.count !== 1) {
        throw new Error("无操作权限或已审核");
      }

      const latest = await tx.purchaseOrder.findUnique({
        where: { id: orderId },
      });
      if (!latest) throw new Error("订单不存在");

      if (!latest.teamApproved || !latest.techGroupApproved) {
        return { updated: latest, advancedToTeacherReview: false };
      }

      const advanced = await tx.purchaseOrder.updateMany({
        where: { id: orderId, status: OrderStatus.MANAGEMENT_REVIEW },
        data: {
          status: OrderStatus.TEACHER_REVIEW,
          ...stepTimerResetFields(),
        },
      });
      const finalOrder = await tx.purchaseOrder.findUnique({
        where: { id: orderId },
      });
      if (!finalOrder) throw new Error("订单不存在");
      return {
        updated: finalOrder,
        advancedToTeacherReview: advanced.count === 1,
      };
    },
  );

  if (advancedToTeacherReview) {
    await enqueueOrderNotification(
      `procurement:order:${updated.id}:${updated.status}:${updated.updatedAt.toISOString()}`,
      {
        id: updated.id,
        orderNo: updated.orderNo,
        initiatorName: updated.initiatorName,
        totalPrice: updated.totalPrice,
        status: updated.status,
        team: updated.team,
        techGroup: updated.techGroup,
        items: mapOrderItems(order.items),
      },
      await getNotificationContext(),
    );
    drainNotificationOutboxSoon();
  }

  revalidateProcurement(orderId);
  return updated;
}
