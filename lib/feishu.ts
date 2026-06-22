import type { OrderStatus, UserRoleType } from "@prisma/client";
import { getFeishuTenantAccessToken } from "@/lib/feishu-auth";
import { getOpenIdsByRole } from "@/lib/permissions";
import {
  roleLabels,
  statusApproverRole,
  statusLabels,
} from "@/lib/permissions-client";
import crypto from "crypto";

const WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.FEISHU_WEBHOOK_SECRET;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export type OrderCardPayload = {
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

function buildOrderCard(order: OrderCardPayload) {
  const detailUrl = `${APP_URL}/orders/${order.id}`;
  const statusLabel = statusLabels[order.status];

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "采购报销审批提醒" },
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
  };
}

async function postToWebhook(body: Record<string, unknown>) {
  if (!WEBHOOK_URL) return;

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

async function sendDirectCard(openId: string, card: ReturnType<typeof buildOrderCard>) {
  const token = await getFeishuTenantAccessToken();
  const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
  url.searchParams.set("receive_id_type", "open_id");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  });

  const data = (await res.json()) as { code: number; msg?: string };
  // #region agent log
  fetch("http://127.0.0.1:7797/ingest/c199d5e2-69f6-40ac-aea6-e151b57e40b3", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "de9726",
    },
    body: JSON.stringify({
      sessionId: "de9726",
      hypothesisId: "B",
      location: "feishu.ts:sendDirectCard",
      message: "dm api response",
      data: {
        feishuCode: data.code,
        success: data.code === 0,
        openIdSuffix: openId.slice(-6),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  if (data.code !== 0) {
    throw new Error(
      `飞书私信发送失败(${openId}): ${data.msg ?? res.status}`,
    );
  }
}

async function notifyApproversByRole(
  role: UserRoleType,
  order: OrderCardPayload,
) {
  const openIds = await getOpenIdsByRole(role);
  if (openIds.length === 0) {
    console.warn(
      `[feishu] 角色 ${roleLabels[role]} 无可通知用户（请确保审批人已飞书登录本系统，且 UserRole.openId 与 User 表一致）`,
    );
    return;
  }

  const card = buildOrderCard(order);
  const results = await Promise.allSettled(
    openIds.map((openId) => sendDirectCard(openId, card)),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[feishu] 私信通知失败:", result.reason);
    }
  }
}

/** 群 Webhook + 私信通知当前状态对应的审批角色 */
export async function sendOrderNotification(order: OrderCardPayload) {
  const card = buildOrderCard(order);

  await postToWebhook({
    msg_type: "interactive",
    card,
  }).catch((err) => {
    console.error("[feishu] Webhook 通知失败:", err);
  });

  const approverRole = statusApproverRole[order.status];
  if (approverRole) {
    await notifyApproversByRole(approverRole, order);
  }
}

/** @deprecated 使用 sendOrderNotification */
export async function sendFeishuCard(order: OrderCardPayload) {
  await sendOrderNotification(order);
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
