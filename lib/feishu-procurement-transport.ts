import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { sendFeishuDirectMessage } from "@/lib/feishu-message";
import { sendTrackedProcurementCardKitDm } from "@/lib/feishu-procurement-card-sync";
import type { OrderCardPayload } from "@/lib/procurement-notification-contract";

export async function sendProcurementDirectCard(
  openId: string,
  card: Record<string, unknown>,
  botKind: FeishuBotKind = "notification",
  options?: {
    trackOrderId?: string;
    trackCardStage?: OrderCardPayload["status"];
  },
) {
  if (card.schema === "2.0") {
    return sendTrackedProcurementCardKitDm(
      openId,
      card,
      botKind,
      options?.trackOrderId,
      options?.trackCardStage,
    );
  }
  return sendFeishuDirectMessage({
    recipientOpenId: openId,
    botKind,
    purpose: botKind === "approval" ? "approval_request" : "notification",
    message: { type: "interactive", card },
    logContext: {
      action: "sendProcurementDirectCard",
      channel: "procurement",
      entityType: "PurchaseOrder",
      entityId: options?.trackOrderId,
    },
  });
}
