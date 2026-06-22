import type { OrderStatus, UserRoleType } from "@prisma/client";
import { getFeishuTenantAccessToken } from "@/lib/feishu-auth";
import { getOpenIdsByRole } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
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
  team: string;
  techGroup: string;
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
  const attachmentHint =
    order.status === "PENDING_FINANCE_REVIEW"
      ? "\n**附件**：发票与清单已在订单详情页「流程附件」中，请先查看再上传截图"
      : order.status === "PENDING_APPLICANT_CONFIRM"
        ? "\n**附件**：请打开详情页核对发票、清单与报销截图后确认"
        : "";

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
            `**总金额**：¥${order.totalPrice.toFixed(2)}${attachmentHint}`,
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

async function sendDirectCard(
  openId: string,
  card: ReturnType<typeof buildOrderCard>,
) {
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
  const openIds = await getOpenIdsByRole(role, {
    team: order.team,
    techGroup: order.techGroup,
  });
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

/** 管理审核：分别私信车组组长与技术组组长 */
export async function sendManagementReviewNotification(order: OrderCardPayload) {
  const card = buildOrderCard(order);

  await postToWebhook({
    msg_type: "interactive",
    card,
  }).catch((err) => {
    console.error("[feishu] Webhook 通知失败:", err);
  });

  await notifyApproversByRole("TEAM_ADMIN", order);
  await notifyApproversByRole("TECH_GROUP_ADMIN", order);
}

async function notifyInitiator(order: OrderCardPayload) {
  const record = await prisma.purchaseOrder.findUnique({
    where: { id: order.id },
    include: { initiator: { select: { openId: true } } },
  });
  if (!record?.initiator.openId) return;

  const card = buildOrderCard(order);
  await sendDirectCard(record.initiator.openId, card).catch((err) => {
    console.error("[feishu] 发起人私信通知失败:", err);
  });
}

/** 群 Webhook + 私信通知当前状态对应的处理人 */
export async function sendOrderNotification(order: OrderCardPayload) {
  if (order.status === "MANAGEMENT_REVIEW") {
    await sendManagementReviewNotification(order);
    return;
  }

  const card = buildOrderCard(order);

  await postToWebhook({
    msg_type: "interactive",
    card,
  }).catch((err) => {
    console.error("[feishu] Webhook 通知失败:", err);
  });

  if (
    order.status === "PENDING_APPLICANT_DOCS" ||
    order.status === "PENDING_APPLICANT_CONFIRM"
  ) {
    await notifyInitiator(order);
    return;
  }

  const approverRole = statusApproverRole[order.status];
  if (approverRole) {
    await notifyApproversByRole(approverRole, order);
  }
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
