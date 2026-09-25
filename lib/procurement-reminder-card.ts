import type { OrderStatus } from "@prisma/client";
import type { NotificationContext } from "@/lib/app-origin";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { resolveProcurementBotKind } from "@/lib/feishu-bot-routing";
import { sendFeishuDirectMessage, type FeishuSendResult } from "@/lib/feishu-message";
import {
  buildProcurementCardKitCard,
  supportsProcurementCardApproval,
  supportsProcurementCardConfirm,
} from "@/lib/feishu-procurement-card";
import {
  resolveProcurementCardScreenshotOptions,
  resolveProcurementFinanceReviewAttachmentOptions,
} from "@/lib/feishu-procurement-card-assets";
import { sendTrackedProcurementCardKitDm } from "@/lib/feishu-procurement-card-sync";
import { statusLabels } from "@/lib/permissions-client";
import type { OrderCardPayload } from "@/lib/procurement-notification-contract";
import { mapOrderItems } from "@/lib/procurement-notification-contract";

export function toReminderOrderCardPayload(order: {
  id: string;
  orderNo: string;
  initiatorName: string;
  totalPrice: number;
  status: OrderStatus;
  team: string;
  techGroup: string;
  screenshotPath?: string | null;
  items: { name: string; quantity: number; unitPrice: number }[];
}): OrderCardPayload {
  return {
    id: order.id,
    orderNo: order.orderNo,
    initiatorName: order.initiatorName,
    totalPrice: order.totalPrice,
    status: order.status,
    team: order.team,
    techGroup: order.techGroup,
    screenshotPath: order.screenshotPath,
    items: mapOrderItems(order.items),
  };
}

export async function buildReminderCard(
  order: OrderCardPayload,
  context: NotificationContext | undefined,
  options: { headerTitle: string; extraLines: string[] },
) {
  const botKind = resolveProcurementBotKind(order.status);
  const screenshotOptions = supportsProcurementCardConfirm(order.status)
    ? await resolveProcurementCardScreenshotOptions(order, botKind, context?.appOrigin)
    : {};
  const financeAttachmentOptions = order.status === "PENDING_FINANCE_REVIEW"
    ? await resolveProcurementFinanceReviewAttachmentOptions(order, botKind, context?.appOrigin)
    : {};

  if (supportsProcurementCardApproval(order.status)) {
    return buildProcurementCardKitCard(order, {
      headerTitle: options.headerTitle,
      headerTemplate: "orange",
      detailFocus: "approval",
      appOrigin: context?.appOrigin,
      extraLines: options.extraLines,
    });
  }

  return buildProcurementCardKitCard(order, {
    headerTitle: options.headerTitle,
    headerTemplate: "orange",
    detailFocus:
      order.status === "PENDING_APPLICANT_DOCS"
        ? "upload"
        : order.status === "PENDING_APPLICANT_CONFIRM"
          ? "confirm"
          : "approval",
    primaryButtonText: "前往处理",
    appOrigin: context?.appOrigin,
    extraLines: options.extraLines,
    readOnly: !supportsProcurementCardConfirm(order.status),
    ...financeAttachmentOptions,
    ...screenshotOptions,
  });
}

export async function buildStaleReminderCard(
  order: OrderCardPayload,
  stuckDays: number,
  context?: NotificationContext,
) {
  return buildReminderCard(order, context, {
    headerTitle: "采购待办催办",
    extraLines: [
      `**当前环节**：${statusLabels[order.status]}`,
      `**已停留**：${stuckDays} 天未处理`,
      "**请尽快处理，避免影响报销进度**",
    ],
  });
}

export async function sendReminderCardToOpenId(
  openId: string,
  card: Record<string, unknown>,
  botKind: FeishuBotKind = "notification",
  orderId?: string,
  cardStage?: OrderStatus,
): Promise<boolean> {
  return (await sendReminderCardToOpenIdResult(openId, card, botKind, orderId, cardStage)).status === "sent";
}

export async function sendReminderCardToOpenIdResult(
  openId: string,
  card: Record<string, unknown>,
  botKind: FeishuBotKind = "notification",
  orderId?: string,
  cardStage?: OrderStatus,
): Promise<FeishuSendResult> {
  if (card.schema === "2.0") {
    return sendTrackedProcurementCardKitDm(
      openId,
      card,
      botKind,
      orderId,
      cardStage,
    );
  }

  return sendFeishuDirectMessage({
    recipientOpenId: openId,
    botKind,
    purpose: botKind === "approval" ? "approval_request" : "notification",
    message: { type: "interactive", card },
    logContext: {
      action: "sendProcurementReminder",
      channel: "procurement",
      entityType: "PurchaseOrder",
      entityId: orderId,
    },
  });
}
