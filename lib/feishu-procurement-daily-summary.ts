import type { OrderStatus } from "@prisma/client";
import { buildAppUrl, type NotificationContext } from "@/lib/app-origin";
import { statusLabels } from "@/lib/permissions-client";
import {
  getProcurementWebhookConfig,
  postToFeishuWebhook,
} from "@/lib/feishu-webhook";
import { routes } from "@/lib/routes";

export async function sendFeishuDailySummary(
  ordersByStatus: Partial<Record<OrderStatus, number>>,
  context?: NotificationContext,
) {
  const lines = Object.entries(ordersByStatus)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([status, count]) => {
      const label = statusLabels[status as OrderStatus] ?? status;
      return `- **${label}**：${count} 单`;
    });
  const content =
    lines.length > 0 ? lines.join("\n") : "- 当前无积压单据，一切正常。";
  const { url, secret } = getProcurementWebhookConfig();
  await postToFeishuWebhook(url, secret, {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "采购报销每日汇总" },
        template: "orange",
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**未完结单据统计**（不含已驳回）\n${content}`,
          },
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "打开系统" },
              url: buildAppUrl(routes.procurement.list, context?.appOrigin),
              type: "default",
            },
          ],
        },
      ],
    },
  });
}
