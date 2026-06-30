import type { OrderStatus, UserRoleType } from "@prisma/client";
import { getFeishuTenantAccessToken } from "@/lib/feishu-auth";
import {
  buildProcurementCardKitCard,
  buildProcurementWebhookCard,
} from "@/lib/feishu-procurement-card";
import {
  sendInteractiveCardKitDm,
} from "@/lib/feishu-cardkit";
import {
  getProcurementWebhookConfig,
  postToFeishuWebhook,
} from "@/lib/feishu-webhook";
import { getOpenIdsByRole } from "@/lib/permissions";
import { buildAppUrl, type NotificationContext } from "@/lib/app-origin";
import { prisma } from "@/lib/prisma";
import {
  roleLabels,
  statusApproverRole,
  statusLabels,
} from "@/lib/permissions-client";
import { routes } from "@/lib/routes";

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
  readOnly?: boolean;
};

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

async function postProcurementWebhook(body: Record<string, unknown>) {
  const { url, secret } = getProcurementWebhookConfig();
  await postToFeishuWebhook(url, secret, body);
}

async function sendDirectCard(
  openId: string,
  card: Record<string, unknown>,
) {
  if (card.schema === "2.0") {
    await sendInteractiveCardKitDm(openId, card);
    console.log(`[feishu] CardKit 卡片已发送 openId=${openId}`);
    return;
  }

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

function buildApprovalDmCard(order: OrderCardPayload, options: CardOptions = {}) {
  return buildProcurementCardKitCard(order, options);
}

function buildReadonlyDmCard(order: OrderCardPayload, options: CardOptions = {}) {
  return buildProcurementCardKitCard(order, { ...options, readOnly: true });
}

/** 管理审核：群摘要 + 私信审批人（含明细表与审批按钮） */
export async function sendManagementReviewNotification(
  order: OrderCardPayload,
  context?: NotificationContext,
) {
  const groupCard = buildProcurementWebhookCard(order, {
    detailFocus: "approval",
    appOrigin: context?.appOrigin,
  });

  await postProcurementWebhook({
    msg_type: "interactive",
    card: groupCard,
  }).catch((err) => {
    console.error("[feishu] Webhook 通知失败:", err);
  });

  const approvalCard = buildApprovalDmCard(order, {
    detailFocus: "approval",
    appOrigin: context?.appOrigin,
  });

  const roles: UserRoleType[] = ["TEAM_ADMIN", "TECH_GROUP_ADMIN"];
  const openIdSet = new Set<string>();
  for (const role of roles) {
    const openIds = await getOpenIdsByRole(role, {
      team: order.team,
      techGroup: order.techGroup,
    });
    openIds.forEach((id) => openIdSet.add(id));
  }

  if (openIdSet.size === 0) {
    console.warn(
      "[feishu] 管理审核无可通知审批人（请确保车组/技术组组长已飞书登录本系统）",
    );
    return;
  }

  const results = await Promise.allSettled(
    [...openIdSet].map((openId) => sendDirectCard(openId, approvalCard)),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    const reason = failures[0]?.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new Error(
      `飞书私信通知失败：${failures.length}/${results.length} 个收件人失败；${message}`,
    );
  }
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

  const card = buildReadonlyDmCard(order, cardOptions);
  await sendDirectCard(record.initiator.openId, card);
}

/** 采购审批驳回：通知采购人 */
export async function sendProcurementRejectedNotification(
  order: OrderCardPayload,
  reason: string,
  rejectedByName: string,
  context?: NotificationContext,
) {
  const card = buildProcurementWebhookCard(order, {
    headerTitle: "采购申请已驳回",
    headerTemplate: "red",
    primaryButtonText: "查看详情",
    appOrigin: context?.appOrigin,
    readOnly: true,
    extraLines: [
      `**驳回人**：${rejectedByName}`,
      `**驳回原因**：${reason}`,
      "**说明**：本次采购已终止，不计入采购汇总数据",
    ],
  });

  await postProcurementWebhook({ msg_type: "interactive", card }).catch(
    (err) => {
      console.error("[feishu] Webhook 通知失败:", err);
    },
  );
  await notifyInitiator(order, {
    headerTitle: "采购申请已驳回",
    headerTemplate: "red",
    primaryButtonText: "查看详情",
    appOrigin: context?.appOrigin,
    readOnly: true,
    extraLines: [
      `**驳回人**：${rejectedByName}`,
      `**驳回原因**：${reason}`,
      "**说明**：本次采购已终止，不计入采购汇总数据",
    ],
  });
}

/** 报销员要求采购人重新提交凭证 */
export async function sendApplicantResubmitNotification(
  order: OrderCardPayload,
  reason: string,
  financeName: string,
  context?: NotificationContext,
) {
  const card = buildProcurementWebhookCard(order, {
    headerTitle: "请重新提交报销资料",
    headerTemplate: "orange",
    detailFocus: "upload",
    primaryButtonText: "重新上传凭证",
    appOrigin: context?.appOrigin,
    readOnly: true,
    extraLines: [
      `**报销员**：${financeName}`,
      `**补充说明**：${reason}`,
      "**说明**：请重新上传发票、实物照片，系统将重新生成验收清单",
    ],
  });

  await postProcurementWebhook({ msg_type: "interactive", card }).catch(
    (err) => {
      console.error("[feishu] Webhook 通知失败:", err);
    },
  );
  await notifyInitiator(order, {
    headerTitle: "请重新提交报销资料",
    headerTemplate: "orange",
    detailFocus: "upload",
    primaryButtonText: "重新上传凭证",
    appOrigin: context?.appOrigin,
    readOnly: true,
    extraLines: [
      `**报销员**：${financeName}`,
      `**补充说明**：${reason}`,
      "**说明**：请重新上传发票、实物照片，系统将重新生成验收清单",
    ],
  });
}

/** 审批退回草稿：通知采购人修改后重新提交 */
export async function sendProcurementReturnDraftNotification(
  order: OrderCardPayload,
  reason: string,
  returnedByName: string,
  context?: NotificationContext,
) {
  const card = buildProcurementWebhookCard(order, {
    headerTitle: "请修改后重新提交采购申请",
    headerTemplate: "orange",
    primaryButtonText: "继续编辑",
    appOrigin: context?.appOrigin,
    readOnly: true,
    extraLines: [
      `**退回人**：${returnedByName}`,
      `**补充说明**：${reason}`,
      "**说明**：订单已退回草稿，请修改采购明细后重新提交",
    ],
  });

  await postProcurementWebhook({ msg_type: "interactive", card }).catch(
    (err) => {
      console.error("[feishu] Webhook 通知失败:", err);
    },
  );
  await notifyInitiator(order, {
    headerTitle: "请修改后重新提交采购申请",
    headerTemplate: "orange",
    primaryButtonText: "继续编辑",
    appOrigin: context?.appOrigin,
    readOnly: true,
    extraLines: [
      `**退回人**：${returnedByName}`,
      `**补充说明**：${reason}`,
      "**说明**：订单已退回草稿，请修改采购明细后重新提交",
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

  const isTeacherApproval = order.status === "TEACHER_REVIEW";
  const initiatorOnly =
    order.status === "PENDING_APPLICANT_DOCS" ||
    order.status === "PENDING_APPLICANT_CONFIRM";

  if (!initiatorOnly) {
    const groupCard = buildProcurementWebhookCard(order, {
      detailFocus: focus,
      primaryButtonText: buttonText,
      appOrigin: context?.appOrigin,
    });

    await postProcurementWebhook({
      msg_type: "interactive",
      card: groupCard,
    }).catch((err) => {
      console.error("[feishu] Webhook 通知失败:", err);
    });
  }

  const dmCard = isTeacherApproval
    ? buildApprovalDmCard(order, {
        detailFocus: focus,
        primaryButtonText: buttonText,
        appOrigin: context?.appOrigin,
      })
    : buildReadonlyDmCard(order, {
        detailFocus: focus,
        primaryButtonText: buttonText,
        appOrigin: context?.appOrigin,
      });

  if (
    order.status === "PENDING_APPLICANT_DOCS" ||
    order.status === "PENDING_APPLICANT_CONFIRM"
  ) {
    await notifyInitiator(order, {
      detailFocus: focus ?? undefined,
      primaryButtonText: buttonText,
      appOrigin: context?.appOrigin,
      readOnly: true,
    });
    return;
  }

  const approverRole = statusApproverRole[order.status];
  if (approverRole) {
    const openIds = await getOpenIdsByRole(approverRole, {
      team: order.team,
      techGroup: order.techGroup,
    });
    if (openIds.length === 0) {
      console.warn(
        `[feishu] 角色 ${roleLabels[approverRole]} 无可通知用户`,
      );
      return;
    }
    const results = await Promise.allSettled(
      openIds.map((openId) => sendDirectCard(openId, dmCard)),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      const reason = failures[0]?.reason;
      const message =
        reason instanceof Error ? reason.message : String(reason);
      throw new Error(
        `飞书私信通知失败：${failures.length}/${results.length} 个收件人失败；${message}`,
      );
    }
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

  await postProcurementWebhook({
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

export type BudgetThresholdPayload = {
  description: string;
  team: string;
  techGroup: string;
  period: string;
  budgetAmount: number;
  usedAmount: number;
  usagePercent: number;
  threshold: number;
  recipientOpenIds: string[];
};

export async function sendBudgetThresholdNotification(
  payload: BudgetThresholdPayload,
  context?: NotificationContext,
) {
  const headerColor: "red" | "orange" =
    payload.threshold >= 100 ? "red" : "orange";

  const card = {
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
            payload.description
              ? `**描述**：${payload.description}`
              : null,
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
            url: buildAppUrl(routes.procurement.dashboard, context?.appOrigin),
            type: "default",
          },
        ],
      },
    ],
  };

  const results = await Promise.allSettled(
    payload.recipientOpenIds.map((openId) => sendDirectCard(openId, card)),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    const reason = failures[0]?.reason;
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}
