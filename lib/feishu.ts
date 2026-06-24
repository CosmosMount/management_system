import type { OrderStatus, UserRoleType } from "@prisma/client";
import { getFeishuTenantAccessToken } from "@/lib/feishu-auth";
import { getOpenIdsByRole } from "@/lib/permissions";
import { buildAppUrl, type NotificationContext } from "@/lib/app-origin";
import { prisma } from "@/lib/prisma";
import {
  roleLabels,
  statusApproverRole,
  statusLabels,
} from "@/lib/permissions-client";
import crypto from "crypto";

const WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.FEISHU_WEBHOOK_SECRET;

export type OrderItemSummary = {
  name: string;
  quantity: number;
  unitPrice: number;
};

export function mapOrderItems(
  items: { name: string; quantity: number; unitPrice: number }[],
): OrderItemSummary[] {
  return items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
  }));
}

export type OrderCardPayload = {
  id: string;
  orderNo: string;
  initiatorName: string;
  totalPrice: number;
  status: OrderStatus;
  team: string;
  techGroup: string;
  items?: OrderItemSummary[];
};

type CardOptions = {
  headerTitle?: string;
  headerTemplate?: "blue" | "red" | "orange" | "green";
  extraLines?: string[];
  detailFocus?: "approval" | "upload" | "confirm";
  primaryButtonText?: string;
  appOrigin?: string | null;
};

function buildSign(timestamp: string, secret: string): string {
  return crypto
    .createHmac("sha256", "")
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
}

function formatItemsSummary(items?: OrderItemSummary[]): string {
  if (!items || items.length === 0) return "";
  const lines = items.slice(0, 5).map(
    (item) =>
      `- ${item.name} ×${item.quantity}（¥${(item.quantity * item.unitPrice).toFixed(2)}）`,
  );
  if (items.length > 5) {
    lines.push(`- …共 ${items.length} 项`);
  }
  return `\n**采购明细**\n${lines.join("\n")}`;
}

function buildDetailUrl(
  orderId: string,
  focus?: CardOptions["detailFocus"],
  appOrigin?: string | null,
) {
  const base = buildAppUrl(`/orders/${orderId}`, appOrigin);
  const notify = "from=notify";
  if (focus === "approval") return `${base}?focus=approval&${notify}#approval`;
  if (focus === "upload") return `${base}?focus=upload&${notify}#upload`;
  if (focus === "confirm") return `${base}?focus=confirm&${notify}#confirm`;
  return `${base}?${notify}#approval`;
}

function defaultDetailFocus(
  status: OrderStatus,
): CardOptions["detailFocus"] | undefined {
  if (
    status === "MANAGEMENT_REVIEW" ||
    status === "TEACHER_REVIEW" ||
    status === "PENDING_FINANCE_REVIEW"
  ) {
    return "approval";
  }
  if (status === "PENDING_APPLICANT_DOCS") return "upload";
  if (status === "PENDING_APPLICANT_CONFIRM") return "confirm";
  return undefined;
}

function buildOrderCard(order: OrderCardPayload, options: CardOptions = {}) {
  const statusLabel = statusLabels[order.status];
  const focus = options.detailFocus ?? defaultDetailFocus(order.status);
  const detailUrl = buildDetailUrl(order.id, focus, options.appOrigin);

  const attachmentHint =
    order.status === "PENDING_FINANCE_REVIEW"
      ? "\n**操作提示**：请打开详情页查看发票与清单，确认无误后上传报销截图；资料不全可要求采购人重新提交"
      : order.status === "PENDING_APPLICANT_CONFIRM"
        ? "\n**操作提示**：请核对发票、清单与报销截图后确认"
        : order.status === "PENDING_APPLICANT_DOCS"
          ? "\n**操作提示**：请重新上传发票、实物照片，系统将自动生成验收清单"
          : order.status === "MANAGEMENT_REVIEW" ||
              order.status === "TEACHER_REVIEW"
            ? "\n**操作提示**：请在详情页「审批操作」区域通过或驳回"
            : "";

  const content = [
    `**当前状态**：${statusLabel}`,
    `**申请人**：${order.initiatorName}`,
    `**车组 / 技术组**：${order.team} / ${order.techGroup}`,
    `**单号**：${order.orderNo}`,
    `**总金额**：¥${order.totalPrice.toFixed(2)}`,
    formatItemsSummary(order.items),
    attachmentHint,
    ...(options.extraLines ?? []),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: options.headerTitle ?? "采购报销审批提醒",
      },
      template: options.headerTemplate ?? "blue",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: options.primaryButtonText ?? "前往处理",
            },
            url: detailUrl,
            type: "primary",
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "订单列表" },
            url: buildAppUrl("/orders", options.appOrigin),
            type: "default",
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
  cardOptions?: CardOptions,
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

  const card = buildOrderCard(order, cardOptions);
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
export async function sendManagementReviewNotification(
  order: OrderCardPayload,
  context?: NotificationContext,
) {
  const card = buildOrderCard(order, {
    detailFocus: "approval",
    primaryButtonText: "前往审批",
    appOrigin: context?.appOrigin,
  });

  await postToWebhook({
    msg_type: "interactive",
    card,
  }).catch((err) => {
    console.error("[feishu] Webhook 通知失败:", err);
  });

  await notifyApproversByRole("TEAM_ADMIN", order, {
    detailFocus: "approval",
    primaryButtonText: "前往审批",
    appOrigin: context?.appOrigin,
  });
  await notifyApproversByRole("TECH_GROUP_ADMIN", order, {
    detailFocus: "approval",
    primaryButtonText: "前往审批",
    appOrigin: context?.appOrigin,
  });
}

async function notifyInitiator(
  order: OrderCardPayload,
  cardOptions?: CardOptions,
) {
  const record = await prisma.purchaseOrder.findUnique({
    where: { id: order.id },
    include: { initiator: { select: { openId: true } } },
  });
  if (!record?.initiator.openId) return;

  const card = buildOrderCard(order, cardOptions);
  await sendDirectCard(record.initiator.openId, card).catch((err) => {
    console.error("[feishu] 发起人私信通知失败:", err);
  });
}

/** 采购审批驳回：通知采购人 */
export async function sendProcurementRejectedNotification(
  order: OrderCardPayload,
  reason: string,
  rejectedByName: string,
  context?: NotificationContext,
) {
  const card = buildOrderCard(order, {
    headerTitle: "采购申请已驳回",
    headerTemplate: "red",
    primaryButtonText: "查看详情",
    appOrigin: context?.appOrigin,
    extraLines: [
      `**驳回人**：${rejectedByName}`,
      `**驳回原因**：${reason}`,
      "**说明**：本次采购已终止，不计入采购汇总数据",
    ],
  });

  await postToWebhook({ msg_type: "interactive", card }).catch((err) => {
    console.error("[feishu] Webhook 通知失败:", err);
  });
  await notifyInitiator(order, {
    headerTitle: "采购申请已驳回",
    headerTemplate: "red",
    primaryButtonText: "查看详情",
    appOrigin: context?.appOrigin,
    extraLines: [
      `**驳回人**：${rejectedByName}`,
      `**驳回原因**：${reason}`,
      "**说明**：本次采购已终止，不计入采购汇总数据",
    ],
  });
}

/** 报销员要求重新提交凭证 */
export async function sendApplicantResubmitNotification(
  order: OrderCardPayload,
  reason: string,
  financeName: string,
  context?: NotificationContext,
) {
  const card = buildOrderCard(order, {
    headerTitle: "请重新提交报销资料",
    headerTemplate: "orange",
    detailFocus: "upload",
    primaryButtonText: "重新上传凭证",
    appOrigin: context?.appOrigin,
    extraLines: [
      `**报销员**：${financeName}`,
      `**补充说明**：${reason}`,
      "**说明**：请重新上传发票、实物照片，系统将重新生成验收清单",
    ],
  });

  await postToWebhook({ msg_type: "interactive", card }).catch((err) => {
    console.error("[feishu] Webhook 通知失败:", err);
  });
  await notifyInitiator(order, {
    headerTitle: "请重新提交报销资料",
    headerTemplate: "orange",
    detailFocus: "upload",
    primaryButtonText: "重新上传凭证",
    appOrigin: context?.appOrigin,
    extraLines: [
      `**报销员**：${financeName}`,
      `**补充说明**：${reason}`,
      "**说明**：请重新上传发票、实物照片，系统将重新生成验收清单",
    ],
  });
}

/** 群 Webhook + 私信通知当前状态对应的处理人 */
export async function sendOrderNotification(
  order: OrderCardPayload,
  context?: NotificationContext,
) {
  if (order.status === "MANAGEMENT_REVIEW") {
    await sendManagementReviewNotification(order, context);
    return;
  }

  const focus = defaultDetailFocus(order.status);
  const buttonText =
    focus === "approval"
      ? "前往审批"
      : focus === "upload"
        ? "上传凭证"
        : focus === "confirm"
          ? "前往确认"
          : "查看详情";

  const card = buildOrderCard(order, {
    detailFocus: focus,
    primaryButtonText: buttonText,
    appOrigin: context?.appOrigin,
  });

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
    await notifyInitiator(order, {
      detailFocus: focus ?? undefined,
      primaryButtonText: buttonText,
      appOrigin: context?.appOrigin,
    });
    return;
  }

  const approverRole = statusApproverRole[order.status];
  if (approverRole) {
    await notifyApproversByRole(approverRole, order, {
      detailFocus: focus ?? undefined,
      primaryButtonText: buttonText,
      appOrigin: context?.appOrigin,
    });
  }
}

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
            content: `**未完结单据统计**（不含已驳回）\n${content}`,
          },
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "打开系统" },
              url: buildAppUrl("/orders", context?.appOrigin),
              type: "default",
            },
          ],
        },
      ],
    },
  });
}
