"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueApplicantResubmitNotification,
  enqueueProcurementRejectedNotificationTx,
  enqueueProcurementReturnDraftNotificationTx,
} from "@/lib/notification-outbox";
import { refreshProcurementFeishuCards } from "@/lib/feishu-procurement-card-sync";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { prisma } from "@/lib/prisma";
import {
  canRejectProcurement,
  canRequestApplicantResubmit,
  getUserRoles,
} from "@/lib/permissions";
import type { ProcurementRejectOutcome } from "@/lib/procurement-reject-outcome";
import { getNotificationContext } from "@/lib/request-origin";
import { revalidateProcurement } from "@/lib/revalidate";
import { OrderStatus } from "@prisma/client";

const inputSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().trim().min(1, "请填写说明").max(500),
  outcome: z.enum(["terminate", "resubmit"]),
});

function toOrderCardPayload(order: {
  id: string;
  orderNo: string;
  initiatorName: string;
  totalPrice: number;
  status: OrderStatus;
  team: string;
  techGroup: string;
  items: { name: string; quantity: number; unitPrice: number }[];
}) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    initiatorName: order.initiatorName,
    totalPrice: order.totalPrice,
    status: order.status,
    team: order.team,
    techGroup: order.techGroup,
    items: mapOrderItems(order.items),
  };
}

function assertRejectPermission(
  status: OrderStatus,
  userRoles: Awaited<ReturnType<typeof getUserRoles>>,
  scope: { team: string; techGroup: string },
): void {
  if (
    status === OrderStatus.MANAGEMENT_REVIEW ||
    status === OrderStatus.TEACHER_REVIEW
  ) {
    if (!canRejectProcurement(status, userRoles, scope)) {
      throw new Error("无驳回权限");
    }
    return;
  }

  if (status === OrderStatus.PENDING_FINANCE_REVIEW) {
    if (!canRequestApplicantResubmit(status, userRoles, scope)) {
      throw new Error("无驳回权限");
    }
    return;
  }

  throw new Error("当前状态不允许驳回");
}

/** 各审批环节驳回：可终止流程，或退回采购人重新提交 */
export async function rejectProcurementOrder(input: {
  orderId: string;
  reason: string;
  outcome: ProcurementRejectOutcome;
}) {
  const session = await auth();
  if (!session?.user?.openId) {
    throw new Error("未登录");
  }

  const { orderId, reason, outcome } = inputSchema.parse(input);
  const userRoles = await getUserRoles(session.user.openId);
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  const scope = { team: order.team, techGroup: order.techGroup };
  assertRejectPermission(order.status, userRoles, scope);

  const user = await prisma.user.findUnique({
    where: { openId: session.user.openId },
    select: { name: true },
  });
  const actorName = user?.name ?? session.user.name ?? "审批人";
  const context = await getNotificationContext();
  const orderPayload = toOrderCardPayload(order);

  if (
    order.status === OrderStatus.MANAGEMENT_REVIEW ||
    order.status === OrderStatus.TEACHER_REVIEW
  ) {
    if (outcome === "terminate") {
      await prisma.$transaction(async (tx) => {
        const locked = await tx.purchaseOrder.updateMany({
          where: { id: orderId, status: order.status },
          data: {
            status: OrderStatus.REJECTED,
            teamApproved: false,
            techGroupApproved: false,
            teamApproverOpenId: null,
            techGroupApproverOpenId: null,
            rejectionReason: reason,
            rejectedAt: new Date(),
            rejectedByName: actorName,
          },
        });
        if (locked.count !== 1) {
          throw new Error("订单状态已更新，请刷新后重试");
        }
        const record = await tx.purchaseOrder.findUniqueOrThrow({
          where: { id: orderId },
        });
        await enqueueProcurementRejectedNotificationTx(
          tx,
          `procurement:rejected:${record.id}:${record.updatedAt.toISOString()}`,
          toOrderCardPayload({ ...order, status: record.status }),
          reason,
          actorName,
          context,
        );
      });
    } else {
      await prisma.$transaction(async (tx) => {
        const updated = await tx.purchaseOrder.updateMany({
          where: { id: orderId, status: order.status },
          data: {
            status: OrderStatus.DRAFT,
            teamApproved: false,
            techGroupApproved: false,
            teamApproverOpenId: null,
            techGroupApproverOpenId: null,
            rejectionReason: reason,
            rejectedAt: new Date(),
            rejectedByName: actorName,
            ...stepTimerResetFields(),
          },
        });
        if (updated.count !== 1) {
          throw new Error("订单状态已更新，请刷新后重试");
        }
        const record = await tx.purchaseOrder.findUniqueOrThrow({
          where: { id: orderId },
        });
        await enqueueProcurementReturnDraftNotificationTx(
          tx,
          `procurement:return_draft:${record.id}:${record.updatedAt.toISOString()}`,
          { ...orderPayload, status: record.status },
          reason,
          actorName,
          context,
        );
      });
    }
  } else if (order.status === OrderStatus.PENDING_FINANCE_REVIEW) {
    if (outcome === "terminate") {
      await prisma.$transaction(async (tx) => {
        const locked = await tx.purchaseOrder.updateMany({
          where: { id: orderId, status: order.status },
          data: {
            status: OrderStatus.REJECTED,
            rejectionReason: reason,
            rejectedAt: new Date(),
            rejectedByName: actorName,
          },
        });
        if (locked.count !== 1) {
          throw new Error("订单状态已更新，请刷新后重试");
        }
        const record = await tx.purchaseOrder.findUniqueOrThrow({
          where: { id: orderId },
        });
        await enqueueProcurementRejectedNotificationTx(
          tx,
          `procurement:rejected:${record.id}:${record.updatedAt.toISOString()}`,
          toOrderCardPayload({ ...order, status: record.status }),
          reason,
          actorName,
          context,
        );
      });
    } else {
      const updated = await prisma.$transaction(async (tx) => {
        await tx.purchaseItem.updateMany({
          where: { orderId },
          data: { photoPath: null },
        });
        const locked = await tx.purchaseOrder.updateMany({
          where: { id: orderId, status: order.status },
          data: {
            status: OrderStatus.PENDING_APPLICANT_DOCS,
            invoicePaths: "[]",
            invoicePath: null,
            listDocPath: null,
            screenshotPath: null,
            rejectionReason: reason,
            rejectedAt: new Date(),
            rejectedByName: actorName,
            ...stepTimerResetFields(),
          },
        });
        if (locked.count !== 1) {
          throw new Error("订单状态已更新，请刷新后重试");
        }
        return tx.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } });
      });
      await enqueueApplicantResubmitNotification(
        `procurement:resubmit:${updated.id}:${updated.updatedAt.toISOString()}`,
        toOrderCardPayload({ ...order, status: updated.status }),
        reason,
        actorName,
        context,
      );
    }
  }

  try {
    if (
      order.status === OrderStatus.MANAGEMENT_REVIEW ||
      order.status === OrderStatus.TEACHER_REVIEW
    ) {
      await refreshProcurementFeishuCards(
        orderId,
        outcome === "terminate"
          ? `已驳回终止，订单 ${order.orderNo} 已结束`
          : `已退回修改，已通知采购人 ${order.initiatorName}`,
      );
    }
    drainNotificationOutboxSoon();
  } catch (err) {
    console.error("[procurement] drain notification outbox failed:", err);
  }

  revalidateProcurement(orderId);
  return { id: orderId };
}
