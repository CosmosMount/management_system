import type { OrderStatus } from "@prisma/client";
import { mapOrderItems, type OrderCardPayload } from "@/lib/feishu";
import { getFeishuTenantAccessToken } from "@/lib/feishu-auth";
import {
  buildProcurementCardKitCard,
  supportsProcurementCardApproval,
} from "@/lib/feishu-procurement-card";
import { sendInteractiveCardKitDm } from "@/lib/feishu-cardkit";
import { getOpenIdsByRole } from "@/lib/permissions";
import type { NotificationContext } from "@/lib/app-origin";

import { prisma } from "@/lib/prisma";
import { statusApproverRole, statusLabels } from "@/lib/permissions-client";

const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

const REMINDABLE_STATUSES: OrderStatus[] = [
  "MANAGEMENT_REVIEW",
  "TEACHER_REVIEW",
  "PENDING_APPLICANT_DOCS",
  "PENDING_FINANCE_REVIEW",
  "PENDING_APPLICANT_CONFIRM",
];

function daysStuck(statusEnteredAt: Date): number {
  return Math.floor(
    (Date.now() - statusEnteredAt.getTime()) / REMINDER_INTERVAL_MS,
  );
}

function shouldSendReminder(order: {
  statusEnteredAt: Date;
  lastReminderAt: Date | null;
}): boolean {
  const stuckMs = Date.now() - order.statusEnteredAt.getTime();
  if (stuckMs < REMINDER_INTERVAL_MS) return false;
  if (!order.lastReminderAt) return true;
  return Date.now() - order.lastReminderAt.getTime() >= REMINDER_INTERVAL_MS;
}

function toCardPayload(order: {
  id: string;
  orderNo: string;
  initiatorName: string;
  totalPrice: number;
  status: OrderStatus;
  team: string;
  techGroup: string;
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
    items: mapOrderItems(order.items),
  };
}

async function sendDirectStaleCard(
  openId: string,
  card: Record<string, unknown>,
) {
  if (card.schema === "2.0") {
    await sendInteractiveCardKitDm(openId, card);
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
      `飞书催办私信失败(${openId}): ${data.msg ?? res.status}`,
    );
  }
}

function buildStaleCard(
  order: OrderCardPayload,
  stuckDays: number,
  context?: NotificationContext,
) {
  const statusLabel = statusLabels[order.status];
  const extraLines = [
    `**当前环节**：${statusLabel}`,
    `**已停留**：${stuckDays} 天未处理`,
    "**请尽快处理，避免影响报销进度**",
  ];

  if (supportsProcurementCardApproval(order.status)) {
    return buildProcurementCardKitCard(order, {
      headerTitle: "采购待办催办",
      headerTemplate: "orange",
      detailFocus: "approval",
      appOrigin: context?.appOrigin,
      extraLines,
    });
  }

  return buildProcurementCardKitCard(order, {
    headerTitle: "采购待办催办",
    headerTemplate: "orange",
    detailFocus:
      order.status === "PENDING_APPLICANT_DOCS"
        ? "upload"
        : order.status === "PENDING_APPLICANT_CONFIRM"
          ? "confirm"
          : "approval",
    primaryButtonText: "前往处理",
    appOrigin: context?.appOrigin,
    extraLines,
    readOnly: true,
  });
}

async function notifyInitiatorStale(
  orderId: string,
  card: Record<string, unknown>,
) {
  const record = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { initiator: { select: { openId: true } } },
  });
  if (!record?.initiator.openId) return;
  await sendDirectStaleCard(record.initiator.openId, card);
}

async function notifyRoleStale(
  role: Parameters<typeof getOpenIdsByRole>[0],
  order: OrderCardPayload,
  card: Record<string, unknown>,
) {
  const openIds = await getOpenIdsByRole(role, {
    team: order.team,
    techGroup: order.techGroup,
  });
  for (const openId of openIds) {
    await sendDirectStaleCard(openId, card).catch((err) => {
      console.error("[reminder] 私信失败:", openId, err);
    });
  }
}

async function sendStaleOrderReminder(
  order: OrderCardPayload & {
    teamApproved: boolean;
    techGroupApproved: boolean;
  },
  stuckDays: number,
  context?: NotificationContext,
) {
  const card = buildStaleCard(order, stuckDays, context);

  if (order.status === "MANAGEMENT_REVIEW") {
    const tasks: Promise<void>[] = [];
    if (!order.teamApproved) {
      tasks.push(notifyRoleStale("TEAM_ADMIN", order, card));
    }
    if (!order.techGroupApproved) {
      tasks.push(notifyRoleStale("TECH_GROUP_ADMIN", order, card));
    }
    await Promise.all(tasks);
    return;
  }

  if (
    order.status === "PENDING_APPLICANT_DOCS" ||
    order.status === "PENDING_APPLICANT_CONFIRM"
  ) {
    await notifyInitiatorStale(order.id, card);
    return;
  }

  const role = statusApproverRole[order.status];
  if (role) {
    await notifyRoleStale(role, order, card);
  }
}

/** 在途订单当前环节停留超过 24h 且距上次催办已满 24h 时，私信该环节处理人 */
export async function runProcurementStaleReminders(
  context?: NotificationContext,
): Promise<number> {
  const orders = await prisma.purchaseOrder.findMany({
    where: { status: { in: REMINDABLE_STATUSES } },
    include: { items: true },
  });

  let sent = 0;
  for (const order of orders) {
    if (!shouldSendReminder(order)) continue;

    if (
      order.status === "MANAGEMENT_REVIEW" &&
      order.teamApproved &&
      order.techGroupApproved
    ) {
      continue;
    }

    const payload = toCardPayload(order);
    const stuck = daysStuck(order.statusEnteredAt);

    try {
      await sendStaleOrderReminder(
        {
          ...payload,
          teamApproved: order.teamApproved,
          techGroupApproved: order.techGroupApproved,
        },
        stuck,
        context,
      );
      await prisma.purchaseOrder.update({
        where: { id: order.id },
        data: { lastReminderAt: new Date() },
      });
      sent++;
    } catch (err) {
      console.error(`[reminder] 订单 ${order.orderNo} 催办失败:`, err);
    }
  }

  return sent;
}
