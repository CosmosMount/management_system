import type { NotificationOutbox } from "@prisma/client";
import { defaultAppOrigin } from "@/lib/app-origin";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import {
  isProcurementApprovalNotification,
  resolveProcurementBotKind,
} from "@/lib/feishu-bot-routing";
import {
  PROCUREMENT_ORDER_WEBHOOK_RECIPIENT_OPEN_ID,
  sendApplicantResubmitNotification,
  sendApplicantResubmitNotificationToOpenId,
  sendOrderNotification,
  sendOrderNotificationToOpenId,
  sendProcurementRejectedNotification,
  sendProcurementRejectedNotificationToOpenId,
  sendProcurementReturnDraftNotification,
  sendProcurementReturnDraftNotificationToOpenId,
} from "@/lib/feishu-procurement-order-notifications";
import {
  sendBudgetThresholdNotification,
  sendBudgetThresholdNotificationToOpenId,
} from "@/lib/feishu-procurement-budget-notifications";
import {
  collectOrderInitiatorOpenIds,
  collectOrderNotificationRecipientOpenIds,
} from "@/lib/procurement-notification-recipients";
import {
  orderOutboxPayloadSchema,
  type OrderOutboxPayload,
} from "@/lib/notification-contracts/procurement";
import type {
  NotificationChannelAdapter,
  NotificationDeliveryTarget,
} from "@/lib/notification-channel-adapter";
import { NonRetryableNotificationError } from "@/lib/notification-channel-adapter";
import { CanceledNotificationError } from "@/lib/notification-channel-adapter";
import type { FeishuSendResult } from "@/lib/feishu-message";
import { filterActiveFeishuOpenIds } from "@/lib/active-account";

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
  if (
    recipientOpenId !== PROCUREMENT_ORDER_WEBHOOK_RECIPIENT_OPEN_ID &&
    (await filterActiveFeishuOpenIds([recipientOpenId])).length === 0
  ) {
    throw new CanceledNotificationError("收件人已停用，取消本次投递");
  }
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
      const openIds = await filterActiveFeishuOpenIds(
        data.budget.recipientOpenIds,
      );
      return {
        supported: true,
        openIds,
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
  async sendComposite(row) {
    const { data, botKind } = parseRow(row);
    const context = { appOrigin: data.appOrigin ?? defaultAppOrigin() };
    if (data.kind === "order") {
      await sendOrderNotification(data.order, context, botKind);
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
