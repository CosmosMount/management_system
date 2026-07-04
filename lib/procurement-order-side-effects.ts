import type { OrderStatus } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueOrderNotification,
  orderNotificationEventKey,
} from "@/lib/notification-outbox";
import { checkBudgetAlertsForOrder } from "@/lib/procurement-budget-alerts";
import { getNotificationContext } from "@/lib/request-origin";
import { logger } from "@/lib/logger";

type SubmittedOrder = {
  id: string;
  orderNo: string;
  initiatorName: string;
  totalPrice: number;
  status: OrderStatus;
  team: string;
  techGroup: string;
  statusEnteredAt: Date;
  updatedAt: Date;
  items: { name: string; quantity: number; unitPrice: number }[];
};

/** 订单提交后的通知与预算告警；失败不回滚主业务。 */
export async function runProcurementSubmitSideEffects(
  order: SubmittedOrder,
): Promise<void> {
  try {
    const context = await getNotificationContext();
    await enqueueOrderNotification(
      orderNotificationEventKey(order),
      {
        id: order.id,
        orderNo: order.orderNo,
        initiatorName: order.initiatorName,
        totalPrice: order.totalPrice,
        status: order.status,
        team: order.team,
        techGroup: order.techGroup,
        items: mapOrderItems(order.items),
      },
      context,
    );
    drainNotificationOutboxSoon();
    await checkBudgetAlertsForOrder(order.team, order.techGroup, context);
  } catch (err) {
    logger.error("procurement.order.side_effects.submit.failed", {
      module: "procurement",
      action: "runProcurementSubmitSideEffects",
      entityType: "PurchaseOrder",
      entityId: order.id,
      status: order.status,
      error: err,
    });
  }
}

export async function runProcurementBudgetAlertSideEffects(
  team: string,
  techGroup: string,
): Promise<void> {
  try {
    const context = await getNotificationContext();
    await checkBudgetAlertsForOrder(team, techGroup, context);
  } catch (err) {
    logger.error("procurement.order.side_effects.budget_alert.failed", {
      module: "procurement",
      action: "runProcurementBudgetAlertSideEffects",
      team,
      techGroup,
      error: err,
    });
  }
}
