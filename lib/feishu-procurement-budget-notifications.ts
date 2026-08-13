import { buildAppUrl, type NotificationContext } from "@/lib/app-origin";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { sendProcurementDirectCard } from "@/lib/feishu-procurement-transport";
import type { BudgetThresholdPayload } from "@/lib/procurement-notification-contract";
import { routes } from "@/lib/routes";

function buildBudgetThresholdCard(
  payload: BudgetThresholdPayload,
  appOrigin?: string | null,
) {
  const headerColor: "red" | "orange" =
    payload.threshold >= 100 ? "red" : "orange";
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `采购预算预警 · ${payload.threshold}%`,
      },
      template: headerColor,
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            payload.description ? `**描述**：${payload.description}` : null,
            `**车组 / 技术组**：${payload.team} / ${payload.techGroup}`,
            `**周期**：${payload.period}`,
            `**预算额度**：¥${payload.budgetAmount.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`,
            `**已使用**：¥${payload.usedAmount.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}（${payload.usagePercent.toFixed(1)}%）`,
            `**预警线**：已达 ${payload.threshold}%`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "查看采购看板" },
            url: buildAppUrl(routes.procurement.dashboard, appOrigin),
            type: "default",
          },
        ],
      },
    ],
  };
}

export async function sendBudgetThresholdNotificationToOpenId(
  payload: BudgetThresholdPayload,
  recipientOpenId: string,
  context?: NotificationContext,
  botKind: FeishuBotKind = "notification",
) {
  return sendProcurementDirectCard(
    recipientOpenId,
    buildBudgetThresholdCard(payload, context?.appOrigin),
    botKind,
  );
}

export async function sendBudgetThresholdNotification(
  payload: BudgetThresholdPayload,
  context?: NotificationContext,
  botKind: FeishuBotKind = "notification",
) {
  const results = await Promise.allSettled(
    payload.recipientOpenIds.map((openId) =>
      sendBudgetThresholdNotificationToOpenId(payload, openId, context, botKind),
    ),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason instanceof Error
      ? failure.reason
      : new Error(String(failure.reason));
  }
}
