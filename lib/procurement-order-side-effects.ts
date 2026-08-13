import type { OrderStatus, Prisma } from "@prisma/client";
import { mapOrderItems } from "@/lib/feishu";
import {
  enqueueOrderNotificationTx,
  orderNotificationEventKey,
} from "@/lib/notification-producers/procurement";
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

export async function enqueueProcurementSubmitNotificationTx(
  tx: Prisma.TransactionClient,
  order: SubmittedOrder,
  context: Awaited<ReturnType<typeof getNotificationContext>>,
): Promise<void> {
  await enqueueOrderNotificationTx(
    tx,
    orderNotificationEventKey(order),
    {
      id: order.id,
      orderNo: order.orderNo,
      initiatorName: order.initiatorName,
      totalPrice: order.totalPrice,
      status: order.status,
      statusEnteredAt: order.statusEnteredAt,
      team: order.team,
      techGroup: order.techGroup,
      items: mapOrderItems(order.items),
    },
    context,
  );
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
