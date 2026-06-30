import { OrderStatus } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueOrderNotificationTx,
} from "@/lib/notification-outbox";
import { getDefaultNotificationContext } from "@/lib/request-origin";
import { stepTimerResetFields } from "@/lib/order-step-timer";
import { prisma } from "@/lib/prisma";
import {
  canApproveOrder,
  canApproveTeamManagement,
  canApproveTechGroupManagement,
  getUserRoles,
} from "@/lib/permissions";
import { requireApproverSignature } from "@/lib/user-signature";

type ApproveOptions = {
  teacherOnly?: boolean;
};

export async function approveProcurementByOpenId(
  openId: string,
  orderId: string,
  options: ApproveOptions = {},
): Promise<{ message: string }> {
  const userRoles = await getUserRoles(openId);
  if (userRoles.length === 0) {
    throw new Error("当前账号无审批角色，请先在系统中配置角色");
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) {
    throw new Error("订单不存在");
  }

  const scope = { team: order.team, techGroup: order.techGroup };

  if (order.status === OrderStatus.MANAGEMENT_REVIEW) {
    if (options.teacherOnly) {
      throw new Error("当前为管理审核，不能使用老师审核操作");
    }

    const state = {
      teamApproved: order.teamApproved,
      techGroupApproved: order.techGroupApproved,
    };
    const canTeam = canApproveTeamManagement(userRoles, scope, state);
    const canTech = canApproveTechGroupManagement(userRoles, scope, state);
    if (!canTeam && !canTech) {
      throw new Error("无管理审核权限或该环节已处理");
    }

    await requireApproverSignature(openId);

    const notifyContext = getDefaultNotificationContext();
    const { advancedToTeacherReview } = await prisma.$transaction(async (tx) => {
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
                teamApproverOpenId: openId,
              }
            : {}),
          ...(canTech
            ? {
                techGroupApproved: true,
                techGroupApproverOpenId: openId,
              }
            : {}),
          ...stepTimerResetFields(),
        },
      });
      if (approved.count !== 1) {
        throw new Error("订单状态已更新，请刷新后重试");
      }

      const latest = await tx.purchaseOrder.findUnique({ where: { id: orderId } });
      if (!latest) throw new Error("订单不存在");
      if (!latest.teamApproved || !latest.techGroupApproved) {
        return { advancedToTeacherReview: false };
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
          `procurement:order:${finalOrder.id}:${finalOrder.status}:${finalOrder.updatedAt.toISOString()}`,
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
          notifyContext,
        );
      }
      return { advancedToTeacherReview: advanced.count === 1 };
    });

    if (advancedToTeacherReview) {
      drainNotificationOutboxSoon();
      return { message: "管理审核已全部通过，已进入老师审核" };
    }

    return { message: "管理审核已通过" };
  }

  if (order.status === OrderStatus.TEACHER_REVIEW) {
    const managementState = {
      teamApproved: order.teamApproved,
      techGroupApproved: order.techGroupApproved,
    };
    if (
      !canApproveOrder(
        order.status,
        userRoles,
        scope,
        managementState,
      )
    ) {
      throw new Error("无老师审核权限");
    }

    await requireApproverSignature(openId);

    const notifyContext = getDefaultNotificationContext();
    const updated = await prisma.$transaction(async (tx) => {
      const locked = await tx.purchaseOrder.updateMany({
        where: { id: orderId, status: OrderStatus.TEACHER_REVIEW },
        data: {
          status: OrderStatus.PENDING_APPLICANT_DOCS,
          ...stepTimerResetFields(),
        },
      });
      if (locked.count !== 1) {
        throw new Error("订单状态已更新，请刷新后重试");
      }
      const record = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id: orderId },
      });
      await enqueueOrderNotificationTx(
        tx,
        `procurement:order:${record.id}:${record.status}:${record.updatedAt.toISOString()}`,
        {
          id: record.id,
          orderNo: record.orderNo,
          initiatorName: record.initiatorName,
          totalPrice: record.totalPrice,
          status: record.status,
          team: record.team,
          techGroup: record.techGroup,
          items: mapOrderItems(order.items),
        },
        notifyContext,
      );
      return record;
    });

    drainNotificationOutboxSoon();
    return { message: `老师审核已通过，订单 ${updated.orderNo} 待上传凭证` };
  }

  throw new Error("当前订单状态不支持在飞书中审批");
}
