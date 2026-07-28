import { getFeishuTenantAccessTokenByBotKind } from "@/lib/feishu-auth";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { createCardKitInstance } from "@/lib/feishu-cardkit";
import {
  isFeishuDirectMessageAllowed,
  isNotificationDeliveryDisabled,
  logFeishuDeliveryDisabled,
  type FeishuDeliveryBypassOptions,
} from "@/lib/feishu-delivery-guard";
import {
  resolveDirectMessageTarget,
  shouldFallbackApprovalBotUnavailable,
  type FeishuDirectMessageTarget,
  type FeishuReceiveIdType,
} from "@/lib/feishu-recipient";
import { logger } from "@/lib/logger";

export type FeishuMessage =
  | { type: "text"; text: string }
  | { type: "interactive"; card: Record<string, unknown> }
  | { type: "cardkit"; card: Record<string, unknown> };

export type FeishuMessagePurpose = "notification" | "approval_request";

export type FeishuMessageLogContext = {
  action: string;
  channel?: string;
  eventKey?: string;
  entityType?: string;
  entityId?: string;
};

export type FeishuSendResult =
  | {
      status: "sent";
      botKind: FeishuBotKind;
      receiveId: string;
      receiveIdType: FeishuReceiveIdType;
      fallbackUsed: boolean;
      cardId?: string;
    }
  | {
      status: "skipped";
      reason: "delivery_disabled" | "recipient_not_allowed";
    };

export async function sendFeishuDirectMessage({
  recipientOpenId,
  botKind,
  purpose,
  message,
  logContext,
  deliveryOptions,
}: {
  recipientOpenId: string;
  botKind: FeishuBotKind;
  purpose: FeishuMessagePurpose;
  message: FeishuMessage;
  logContext: FeishuMessageLogContext;
  deliveryOptions?: FeishuDeliveryBypassOptions;
}): Promise<FeishuSendResult> {
  if (botKind === "approval" && purpose !== "approval_request") {
    throw new Error("普通通知不得使用审批机器人");
  }

  if (isNotificationDeliveryDisabled(deliveryOptions)) {
    logFeishuDeliveryDisabled({
      action: logContext.action,
      channel: logContext.channel,
      botKind,
      target: "direct_message",
    });
    return { status: "skipped", reason: "delivery_disabled" };
  }

  if (!(await isFeishuDirectMessageAllowed(recipientOpenId))) {
    logger.info("feishu.direct_message.skipped", {
      module: "feishu",
      ...logContext,
      botKind,
      recipientOpenId,
      reason: "recipient_not_allowed",
      result: "skipped",
    });
    return { status: "skipped", reason: "recipient_not_allowed" };
  }

  const target = await resolveDirectMessageTarget(recipientOpenId, botKind);
  try {
    return await sendToTarget(target, message, logContext, false);
  } catch (error) {
    if (!shouldFallbackApprovalBotUnavailable(target.botKind, error)) {
      logger.error("feishu.direct_message.failed", {
        module: "feishu",
        ...logContext,
        botKind: target.botKind,
        receiveIdType: target.receiveIdType,
        recipientOpenId,
        messageType: message.type,
        result: "failure",
        error,
      });
      throw error;
    }

    logger.warn("feishu.direct_message.approval_bot_fallback", {
      module: "feishu",
      ...logContext,
      botKind: target.botKind,
      receiveIdType: target.receiveIdType,
      recipientOpenId,
      messageType: message.type,
      result: "failure",
      error,
    });
    const fallbackTarget = await resolveDirectMessageTarget(
      recipientOpenId,
      "notification",
    );
    return sendToTarget(fallbackTarget, message, logContext, true);
  }
}

async function sendToTarget(
  target: FeishuDirectMessageTarget,
  message: FeishuMessage,
  logContext: FeishuMessageLogContext,
  fallbackUsed: boolean,
): Promise<Extract<FeishuSendResult, { status: "sent" }>> {
  const prepared = await prepareMessage(message, target.botKind);
  const token = await getFeishuTenantAccessTokenByBotKind(target.botKind);
  const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
  url.searchParams.set("receive_id_type", target.receiveIdType);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: target.receiveId,
      msg_type: prepared.msgType,
      content: JSON.stringify(prepared.content),
    }),
  });
  const data = (await response.json()) as { code?: number; msg?: string };
  if (data.code !== 0) {
    const unavailableSuffix =
      data.msg?.toLowerCase().includes("bot has no availability to this user")
        ? ": Bot has NO availability to this user"
        : "";
    throw new Error(
      `飞书私信发送失败(${data.code ?? response.status})${unavailableSuffix}`,
    );
  }

  logger.info("feishu.direct_message.sent", {
    module: "feishu",
    ...logContext,
    botKind: target.botKind,
    receiveIdType: target.receiveIdType,
    messageType: message.type,
    fallbackUsed,
    result: "success",
  });
  return {
    status: "sent",
    botKind: target.botKind,
    receiveId: target.receiveId,
    receiveIdType: target.receiveIdType,
    fallbackUsed,
    ...(prepared.cardId ? { cardId: prepared.cardId } : {}),
  };
}

async function prepareMessage(
  message: FeishuMessage,
  botKind: FeishuBotKind,
): Promise<{
  msgType: "text" | "interactive";
  content: Record<string, unknown>;
  cardId?: string;
}> {
  if (message.type === "text") {
    return { msgType: "text", content: { text: message.text } };
  }
  if (message.type === "interactive") {
    return { msgType: "interactive", content: message.card };
  }

  const cardId = await createCardKitInstance(message.card, botKind);
  return {
    msgType: "interactive",
    content: { type: "card", data: { card_id: cardId } },
    cardId,
  };
}
