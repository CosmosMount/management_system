import { OrderStatus } from "@prisma/client";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { canEditProcurementOrder } from "@/lib/permissions-client";
import { prisma } from "@/lib/prisma";

export function procurementWithdrawToDraftFields() {
  return {
    status: OrderStatus.DRAFT,
    teamApproved: false,
    techGroupApproved: false,
    teamApproverOpenId: null,
    techGroupApproverOpenId: null,
    ...stepTimerResetFields(),
  };
}

/** 老师审核通过前，将审批中订单撤回为草稿以便采购人编辑 */
export async function ensureProcurementOrderEditableDraft(
  orderId: string,
  userOpenId: string,
) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      initiator: { select: { openId: true } },
    },
  });
  if (!order) {
    throw new Error("订单不存在");
  }
  if (
    !canEditProcurementOrder(
      order.status,
      userOpenId,
      order.initiator.openId,
    )
  ) {
    throw new Error("无权限编辑该订单");
  }
  if (order.status === OrderStatus.DRAFT) {
    return order;
  }

  if (
    order.status !== OrderStatus.MANAGEMENT_REVIEW &&
    order.status !== OrderStatus.TEACHER_REVIEW
  ) {
    throw new Error("当前状态不可编辑");
  }

  const updated = await prisma.purchaseOrder.updateMany({
    where: { id: orderId, status: order.status },
    data: procurementWithdrawToDraftFields(),
  });
  if (updated.count !== 1) {
    throw new Error("订单状态已更新，请刷新后重试");
  }

  return prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: true,
      initiator: { select: { openId: true } },
    },
  });
}
