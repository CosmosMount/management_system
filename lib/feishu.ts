import type { OrderStatus } from "@prisma/client";
import { statusLabels } from "@/lib/permissions-client";
import crypto from "crypto";

const WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.FEISHU_WEBHOOK_SECRET;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

type OrderCardPayload = {
  id: string;
  orderNo: string;
  initiatorName: string;
  totalPrice: number;
  status: OrderStatus;
};

function buildSign(timestamp: string, secret: string): string {
  return crypto
    .createHmac("sha256", "")
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
}

async function postToWebhook(body: Record<string, unknown>) {
  if (!WEBHOOK_URL) {
    console.warn("[feishu] FEISHU_WEBHOOK_URL 未配置，跳过消息发送");
    return;
  }

  const payload: Record<string, unknown> = { ...body };
  if (WEBHOOK_SECRET) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = buildSign(timestamp, WEBHOOK_SECRET);
  }

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`飞书 Webhook 请求失败: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { code?: number; msg?: string };
  if (data.code !== undefined && data.code !== 0) {
    throw new Error(`飞书 Webhook 返回错误: ${data.msg ?? "unknown"}`);
  }
}

export async function sendFeishuCard(order: OrderCardPayload) {
  const detailUrl = `${APP_URL}/orders/${order.id}`;
  const statusLabel = statusLabels[order.status];

  await postToWebhook({
    msg_type: "interactive",
    card: {
      header: {
        title: {
          tag: "plain_text",
          content: "采购报销审批提醒",
        },
        template: "blue",
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: [
              `**当前状态**：${statusLabel}`,
              `**申请人**：${order.initiatorName}`,
              `**单号**：${order.orderNo}`,
              `**总金额**：¥${order.totalPrice.toFixed(2)}`,
            ].join("\n"),
          },
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "查看详情" },
              url: detailUrl,
              type: "primary",
            },
          ],
        },
      ],
    },
  });
}

export async function sendFeishuDailySummary(
  ordersByStatus: Partial<Record<OrderStatus, number>>,
) {
  const lines = Object.entries(ordersByStatus)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([status, count]) => {
      const label = statusLabels[status as OrderStatus] ?? status;
      return `- **${label}**：${count} 单`;
    });

  const content =
    lines.length > 0
      ? lines.join("\n")
      : "- 当前无积压单据，一切正常。";

  await postToWebhook({
    msg_type: "interactive",
    card: {
      header: {
        title: {
          tag: "plain_text",
          content: "采购报销每日汇总",
        },
        template: "orange",
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: `**未完结单据统计**\n${content}`,
          },
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "打开系统" },
              url: `${APP_URL}/orders`,
              type: "default",
            },
          ],
        },
      ],
    },
  });
}
