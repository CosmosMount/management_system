"use server";

import { auth } from "@/lib/auth";
import { OrderStatus } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueOrderNotificationTx,
  orderNotificationEventKey,
} from "@/lib/notification-outbox";
import { refreshProcurementFeishuCards } from "@/lib/feishu-procurement-card-sync";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { prisma } from "@/lib/prisma";
import { revalidateProcurement } from "@/lib/revalidate";
import { getNotificationContext } from "@/lib/request-origin";
import { withActionLogging } from "@/lib/logger";
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
  return withActionLogging(
    {
      event: "procurement.management_review.approve",
      module: "procurement",
      action: "approveManagementReview",
      actorOpenId: session.user.openId,
      actorName: session.user.name ?? "",
      entityType: "PurchaseOrder",
      entityId: orderId,
    },
    async () => approveManagementReviewLogged(orderId, session.user.openId),
  );
}

async function approveManagementReviewLogged(orderId: string, userOpenId: string) {
  const userRoles = await getUserRoles(userOpenId);
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

  await requireApproverSignature(userOpenId);

  const context = await getNotificationContext();
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
          ...(canTeam
            ? {
                teamApproved: true,
                teamApproverOpenId: userOpenId,
              }
            : {}),
          ...(canTech
            ? {
                techGroupApproved: true,
                techGroupApproverOpenId: userOpenId,
              }
            : {}),
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
      if (advanced.count === 1) {
        await enqueueOrderNotificationTx(
          tx,
          orderNotificationEventKey(finalOrder),
          {
            id: finalOrder.id,
            orderNo: finalOrder.orderNo,
            initiatorName: finalOrder.initiatorName,
            totalPrice: finalOrder.totalPrice,
            status: finalOrder.status,
            team: finalOrder.team,
            techGroup: finalOrder.techGroup,
            items: mapOrderItems(order.items),
          },
          context,
        );
      }
      return {
        updated: finalOrder,
        advancedToTeacherReview: advanced.count === 1,
      };
    },
  );

  if (advancedToTeacherReview) {
    await refreshProcurementFeishuCards(
      orderId,
      "管理审核已全部通过，已进入老师审核",
    );
    drainNotificationOutboxSoon();
  }

  revalidateProcurement(orderId);
  return updated;
}
