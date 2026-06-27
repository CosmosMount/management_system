import type { OrderStatus } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  drainNotificationOutboxSoon,
  enqueueOrderNotification,
} from "@/lib/notification-outbox";
import { checkBudgetAlertsForOrder } from "@/lib/procurement-budget-alerts";
import { getNotificationContext } from "@/lib/request-origin";

type SubmittedOrder = {
  id: string;
  orderNo: string;
  initiatorName: string;
  totalPrice: number;
  status: OrderStatus;
  team: string;
  techGroup: string;
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
      `procurement:order:${order.id}:${order.status}:${order.updatedAt.toISOString()}`,
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
    console.error("[procurement] post-submit side effects failed:", err);
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
    console.error("[procurement] budget alert side effects failed:", err);
  }
}
