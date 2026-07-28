import type { NotificationOutbox } from "@prisma/client";
import { z } from "zod";
import { defaultAppOrigin } from "@/lib/app-origin";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import {
  isProcurementApprovalNotification,
  resolveProcurementBotKind,
} from "@/lib/feishu-bot-routing";
import {
  collectOrderNotificationRecipientOpenIds,
  collectOrderInitiatorOpenIds,
  PROCUREMENT_ORDER_WEBHOOK_RECIPIENT_OPEN_ID,
  sendApplicantResubmitNotification,
  sendApplicantResubmitNotificationToOpenId,
  sendBudgetThresholdNotification,
  sendBudgetThresholdNotificationToOpenId,
  sendOrderNotification,
  sendOrderNotificationToOpenId,
  sendProcurementRejectedNotification,
  sendProcurementRejectedNotificationToOpenId,
  sendProcurementReturnDraftNotification,
  sendProcurementReturnDraftNotificationToOpenId,
  type BudgetThresholdPayload,
  type OrderCardPayload,
} from "@/lib/feishu";
import { sendTeacherReviewEmailsOnce } from "@/lib/procurement-teacher-email";
import type {
  NotificationChannelAdapter,
  NotificationDeliveryTarget,
} from "@/lib/notification-channels/types";
import { NonRetryableNotificationError } from "@/lib/notification-channels/types";
import type { FeishuSendResult } from "@/lib/feishu-message";

const orderSchema = z.object({
  id: z.string().min(1),
  orderNo: z.string().min(1),
  initiatorName: z.string(),
  totalPrice: z.number(),
  status: z.enum([
    "DRAFT",
    "MANAGEMENT_REVIEW",
    "TEACHER_REVIEW",
    "PENDING_APPLICANT_DOCS",
    "PENDING_FINANCE_REVIEW",
    "PENDING_APPLICANT_CONFIRM",
    "COMPLETED",
    "REJECTED",
  ]),
  team: z.string(),
  techGroup: z.string(),
  items: z
    .array(
      z.object({
        name: z.string(),
        quantity: z.number(),
        unitPrice: z.number(),
      }),
    )
    .optional(),
  screenshotPath: z.string().nullable().optional(),
  invoicePaths: z.string().nullable().optional(),
  invoicePath: z.string().nullable().optional(),
  listDocPath: z.string().nullable().optional(),
});

const budgetSchema = z.object({
  description: z.string(),
  team: z.string(),
  techGroup: z.string(),
  period: z.string(),
  budgetAmount: z.number(),
  usedAmount: z.number(),
  usagePercent: z.number(),
  threshold: z.number(),
  recipientOpenIds: z.array(z.string()),
});

const appOriginSchema = z.string().nullable().optional();

const orderOutboxPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("order"), order: orderSchema, appOrigin: appOriginSchema }),
  z.object({
    kind: z.literal("procurement_rejected"),
    order: orderSchema,
    reason: z.string(),
    rejectedByName: z.string(),
    appOrigin: appOriginSchema,
  }),
  z.object({
    kind: z.literal("applicant_resubmit"),
    order: orderSchema,
    reason: z.string(),
    financeName: z.string(),
    appOrigin: appOriginSchema,
  }),
  z.object({
    kind: z.literal("procurement_return_draft"),
    order: orderSchema,
    reason: z.string(),
    returnedByName: z.string(),
    appOrigin: appOriginSchema,
  }),
  z.object({
    kind: z.literal("budget_threshold"),
    budget: budgetSchema,
    appOrigin: appOriginSchema,
  }),
]);

export type OrderOutboxPayload =
  | {
      kind: "order";
      order: OrderCardPayload;
      appOrigin?: string | null;
    }
  | {
      kind: "procurement_rejected";
      order: OrderCardPayload;
      reason: string;
      rejectedByName: string;
      appOrigin?: string | null;
    }
  | {
      kind: "applicant_resubmit";
      order: OrderCardPayload;
      reason: string;
      financeName: string;
      appOrigin?: string | null;
    }
  | {
      kind: "procurement_return_draft";
      order: OrderCardPayload;
      reason: string;
      returnedByName: string;
      appOrigin?: string | null;
    }
  | {
      kind: "budget_threshold";
      budget: BudgetThresholdPayload;
      appOrigin?: string | null;
    };

function parseRow(row: NotificationOutbox): {
  data: OrderOutboxPayload;
  botKind: FeishuBotKind;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.payload);
  } catch {
    throw new NonRetryableNotificationError("采购通知 payload 不是有效 JSON");
  }
  const result = orderOutboxPayloadSchema.safeParse(decoded);
  if (!result.success) {
    throw new NonRetryableNotificationError("采购通知 payload 不符合持久化契约");
  }
  const data = result.data as OrderOutboxPayload;
  if (row.type !== data.kind) {
    throw new NonRetryableNotificationError(
      `采购通知元数据不一致：type=${row.type}，payload.kind=${data.kind}`,
    );
  }
  if (row.botKind !== "notification" && row.botKind !== "approval") {
    throw new NonRetryableNotificationError(
      `采购通知机器人类型无效：${row.botKind}`,
    );
  }
  const actual = row.botKind;
  const expected =
    data.kind === "order"
      ? resolveProcurementBotKind(data.order.status)
      : "notification";
  if (actual !== expected) {
    throw new NonRetryableNotificationError(
      `采购通知机器人类型无效：${data.kind} 应使用 ${expected}`,
    );
  }
  return { data, botKind: actual };
}

function deliveryTarget(result: FeishuSendResult): NotificationDeliveryTarget {
  if (result.status === "skipped") {
    throw new Error(`FEISHU_DELIVERY_SKIPPED: ${result.reason}`);
  }
  return {
    receiveId: result.receiveId,
    receiveIdType: result.receiveIdType,
  };
}

async function sendToRecipient(
  row: NotificationOutbox,
  recipientOpenId: string,
): Promise<NotificationDeliveryTarget> {
  const { data, botKind } = parseRow(row);
  const context = { appOrigin: data.appOrigin ?? defaultAppOrigin() };
  if (data.kind === "order") {
    const result = await sendOrderNotificationToOpenId(
      data.order,
      recipientOpenId,
      context,
      botKind,
    );
    return result ? deliveryTarget(result) : null;
  }
  if (data.kind === "budget_threshold") {
    const result = await sendBudgetThresholdNotificationToOpenId(
      data.budget,
      recipientOpenId,
      context,
      botKind,
    );
    return deliveryTarget(result);
  }
  if (data.kind === "procurement_rejected") {
    const result = await sendProcurementRejectedNotificationToOpenId(
      data.order,
      recipientOpenId,
      data.reason,
      data.rejectedByName,
      context,
      botKind,
    );
    return result ? deliveryTarget(result) : null;
  }
  if (data.kind === "procurement_return_draft") {
    const result = await sendProcurementReturnDraftNotificationToOpenId(
      data.order,
      recipientOpenId,
      data.reason,
      data.returnedByName,
      context,
      botKind,
    );
    return result ? deliveryTarget(result) : null;
  }
  const result = await sendApplicantResubmitNotificationToOpenId(
    data.order,
    recipientOpenId,
    data.reason,
    data.financeName,
    context,
    botKind,
  );
  return result ? deliveryTarget(result) : null;
}

export const procurementNotificationChannel: NotificationChannelAdapter = {
  channel: "procurement",
  async resolveRecipientPlan(row) {
    const { data } = parseRow(row);
    if (data.kind === "order") {
      const directOpenIds = await collectOrderNotificationRecipientOpenIds(
        data.order,
      );
      const openIds = [...directOpenIds];
      if (
        data.order.status !== "PENDING_APPLICANT_DOCS" &&
        data.order.status !== "PENDING_APPLICANT_CONFIRM"
      ) {
        openIds.unshift(PROCUREMENT_ORDER_WEBHOOK_RECIPIENT_OPEN_ID);
      }
      return {
        supported: true,
        openIds: [...new Set(openIds)],
        directOpenIds: [...new Set(directOpenIds)],
        requiresDirectRecipient: isProcurementApprovalNotification(
          data.order.status,
        ),
      };
    }
    if (data.kind === "budget_threshold") {
      return {
        supported: true,
        openIds: [...new Set(data.budget.recipientOpenIds.filter(Boolean))],
      };
    }
    return {
      supported: true,
      openIds: [
        PROCUREMENT_ORDER_WEBHOOK_RECIPIENT_OPEN_ID,
        ...(await collectOrderInitiatorOpenIds(data.order)),
      ],
    };
  },
  sendToRecipient,
  async beforeRecipientDelivery(row) {
    const { data } = parseRow(row);
    if (data.kind === "order") {
      await sendTeacherReviewEmailsOnce(
        data.order,
        { appOrigin: data.appOrigin ?? defaultAppOrigin() },
        row.eventKey,
      );
    }
  },
  async sendComposite(row) {
    const { data, botKind } = parseRow(row);
    const context = { appOrigin: data.appOrigin ?? defaultAppOrigin() };
    if (data.kind === "order") {
      await sendOrderNotification(data.order, context, botKind, {
        outboxEventKey: row.eventKey,
      });
      return;
    }
    if (data.kind === "procurement_rejected") {
      await sendProcurementRejectedNotification(
        data.order,
        data.reason,
        data.rejectedByName,
        context,
        botKind,
      );
      return;
    }
    if (data.kind === "budget_threshold") {
      await sendBudgetThresholdNotification(data.budget, context, botKind);
      return;
    }
    if (data.kind === "procurement_return_draft") {
      await sendProcurementReturnDraftNotification(
        data.order,
        data.reason,
        data.returnedByName,
        context,
        botKind,
      );
      return;
    }
    await sendApplicantResubmitNotification(
      data.order,
      data.reason,
      data.financeName,
      context,
      botKind,
    );
  },
};
