import { OrderStatus } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueProcurementRejectedNotificationTx,
  enqueueProcurementReturnDraftNotification,
} from "@/lib/notification-outbox";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { prisma } from "@/lib/prisma";
import {
  canRejectProcurement,
  getUserRoles,
} from "@/lib/permissions";
import type { ProcurementRejectOutcome } from "@/lib/procurement-reject-outcome";
import { requireApproverSignature } from "@/lib/user-signature";

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

async function resolveActorName(openId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { openId },
    select: { name: true },
  });
  return user?.name ?? "审批人";
}

export async function rejectProcurementByOpenId(
  openId: string,
  orderId: string,
  reason: string,
  outcome: ProcurementRejectOutcome,
): Promise<{ message: string }> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new Error("请填写驳回或退回原因");
  }

  const userRoles = await getUserRoles(openId);
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  const scope = { team: order.team, techGroup: order.techGroup };
  if (
    order.status !== OrderStatus.MANAGEMENT_REVIEW &&
    order.status !== OrderStatus.TEACHER_REVIEW
  ) {
    throw new Error("当前订单状态不支持在飞书中驳回");
  }

  if (!canRejectProcurement(order.status, userRoles, scope)) {
    throw new Error("无驳回权限");
  }

  await requireApproverSignature(openId);
  const actorName = await resolveActorName(openId);
  const orderPayload = toOrderCardPayload(order);

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
          rejectionReason: trimmedReason,
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
        trimmedReason,
        actorName,
      );
    });
    drainNotificationOutboxSoon();
    return { message: `已驳回终止，订单 ${order.orderNo} 已结束` };
  }

  const updated = await prisma.purchaseOrder.updateMany({
    where: { id: orderId, status: order.status },
    data: {
      status: OrderStatus.DRAFT,
      teamApproved: false,
      techGroupApproved: false,
      teamApproverOpenId: null,
      techGroupApproverOpenId: null,
      rejectionReason: trimmedReason,
      rejectedAt: new Date(),
      rejectedByName: actorName,
      ...stepTimerResetFields(),
    },
  });
  if (updated.count !== 1) {
    throw new Error("订单状态已更新，请刷新后重试");
  }

  await enqueueProcurementReturnDraftNotification(
    `procurement:return_draft:${orderId}:${Date.now()}`,
    { ...orderPayload, status: OrderStatus.DRAFT },
    trimmedReason,
    actorName,
  );
  drainNotificationOutboxSoon();
  return { message: `已退回修改，已通知采购人 ${order.initiatorName}` };
}
