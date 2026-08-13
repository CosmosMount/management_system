import type { Prisma } from "@prisma/client";
import type { NotificationContext } from "@/lib/app-origin";
import type {
  BudgetThresholdPayload,
  OrderCardPayload,
} from "@/lib/procurement-notification-contract";
import { resolveProcurementBotKind } from "@/lib/feishu-bot-routing";
import {
  enqueueNotification,
  enqueueNotificationTx,
} from "@/lib/notification-outbox";
import type {
  OrderOutboxPayload,
  TeacherReviewEmailOutboxPayload,
} from "@/lib/notification-contracts/procurement";

type OrderNotificationInput = OrderCardPayload & {
  statusEnteredAt?: Date;
};

export function orderNotificationEventKey(order: {
  id: string;
  status: string;
  statusEnteredAt: Date;
}): string {
  return `procurement:order:${order.id}:${order.status}:${order.statusEnteredAt.toISOString()}`;
}

export async function enqueueOrderNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  order: OrderNotificationInput,
  context?: NotificationContext,
) {
  const result = await enqueueNotificationTx(tx, {
    eventKey,
    channel: "procurement",
    botKind: resolveProcurementBotKind(order.status),
    type: "order",
    payload: {
      kind: "order",
      order,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
  if (order.status === "TEACHER_REVIEW") {
    if (!order.statusEnteredAt) {
      throw new Error("老师审核邮件缺少审批轮次时间");
    }
    await enqueueNotificationTx(tx, {
      eventKey: `${eventKey}:teacher_email`,
      channel: "email",
      type: "teacher_review_email",
      payload: {
        kind: "teacher_review_email",
        order: { ...order, status: "TEACHER_REVIEW" },
        expectedStatusEnteredAt: order.statusEnteredAt.toISOString(),
        appOrigin: context?.appOrigin ?? null,
      } satisfies TeacherReviewEmailOutboxPayload,
    });
  }
  return result;
}

export async function enqueueProcurementRejectedNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  rejectedByName: string,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "procurement_rejected",
    payload: {
      kind: "procurement_rejected",
      order,
      reason,
      rejectedByName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueApplicantResubmitNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  financeName: string,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "applicant_resubmit",
    payload: {
      kind: "applicant_resubmit",
      order,
      reason,
      financeName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueProcurementReturnDraftNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  returnedByName: string,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "procurement_return_draft",
    payload: {
      kind: "procurement_return_draft",
      order,
      reason,
      returnedByName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueBudgetThresholdNotification(
  eventKey: string,
  budget: BudgetThresholdPayload,
  context?: NotificationContext,
) {
  return enqueueNotification({
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "budget_threshold",
    payload: {
      kind: "budget_threshold",
      budget,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}
