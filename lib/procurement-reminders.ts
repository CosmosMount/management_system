import { Prisma, type OrderStatus } from "@prisma/client";
import { enrichOrderCardPayloadFromDb } from "@/lib/feishu-order-card-payload";
import { sendTeacherReviewEmailsOnce } from "@/lib/procurement-teacher-email";
import type { OrderCardPayload } from "@/lib/procurement-notification-contract";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { resolveProcurementBotKind } from "@/lib/feishu-bot-routing";
import { getOpenIdsByRole } from "@/lib/permissions";
import type { NotificationContext } from "@/lib/app-origin";
import { buildReminderCard, sendReminderCardToOpenId, toReminderOrderCardPayload } from "@/lib/procurement-reminder-card";
import { collectReminderRecipientOpenIds } from "@/lib/procurement-reminder-recipients";
import { enqueueNotificationTx } from "@/lib/notification-outbox";
import type { OrderOutboxPayload } from "@/lib/notification-contracts/procurement";

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { statusApproverRole, statusLabels } from "@/lib/permissions-client";
import { drainNotificationOutboxSoon } from "@/lib/notification-delivery";
import { collectOrderInitiatorOpenIds } from "@/lib/procurement-notification-recipients";

const REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MANUAL_REMINDER_COOLDOWN_MS = 60 * 1000;

function minuteBucket(date: Date): string {
  return String(Math.floor(date.getTime() / MANUAL_REMINDER_COOLDOWN_MS));
}

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
}, now: Date): boolean {
  const stuckMs = now.getTime() - order.statusEnteredAt.getTime();
  if (stuckMs < REMINDER_INTERVAL_MS) return false;
  if (!order.lastReminderAt) return true;
  return now.getTime() - order.lastReminderAt.getTime() >= REMINDER_INTERVAL_MS;
}

async function notifyInitiatorStale(
  orderId: string,
  card: Record<string, unknown>,
  botKind: FeishuBotKind,
): Promise<number> {
  const [initiatorOpenId] = await collectOrderInitiatorOpenIds({ id: orderId });
  if (!initiatorOpenId) return 0;
  const record = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    select: { status: true },
  });
  if (!record) return 0;
  return (await sendReminderCardToOpenId(
    initiatorOpenId,
    card,
    botKind,
    orderId,
    record.status,
  ))
    ? 1
    : 0;
}

async function notifyRoleStale(
  role: Parameters<typeof getOpenIdsByRole>[0],
  order: OrderCardPayload,
  card: Record<string, unknown>,
): Promise<number> {
  const botKind = resolveProcurementBotKind(order.status);
  const openIds = await getOpenIdsByRole(role, {
    team: order.team,
    techGroup: order.techGroup,
  });
  let successCount = 0;
  let failureCount = 0;
  let firstFailure: unknown = null;

  for (const openId of openIds) {
    try {
      if (
        await sendReminderCardToOpenId(openId, card, botKind, order.id, order.status)
      ) {
        successCount++;
      }
    } catch (err) {
      failureCount++;
      firstFailure ??= err;
      logger.error("procurement.reminder.recipient.failed", {
        module: "procurement",
        action: "notifyRoleStale",
        entityType: "PurchaseOrder",
        entityId: order.id,
        recipientOpenId: openId,
        result: "failure",
        error: err,
      });
    }
  }

  if (openIds.length > 0 && successCount === 0 && failureCount > 0) {
    const message =
      firstFailure instanceof Error ? firstFailure.message : String(firstFailure);
    throw new Error(`飞书催办私信全部失败：${message}`);
  }

  return successCount;
}

/** 在途订单当前环节停留超过 24h 且距上次入队已满 24h 时，为当前处理人入队催办 */
export async function runProcurementStaleReminders(
  context?: NotificationContext,
): Promise<number> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - REMINDER_INTERVAL_MS);
  let enqueued = 0;
  let afterId: string | undefined;

  while (true) {
    const candidates = await prisma.purchaseOrder.findMany({
      where: {
        ...(afterId ? { id: { gt: afterId } } : {}),
        status: { in: REMINDABLE_STATUSES },
        statusEnteredAt: { lte: cutoff },
        OR: [{ lastReminderAt: null }, { lastReminderAt: { lte: cutoff } }],
      },
      select: { id: true, orderNo: true },
      orderBy: { id: "asc" },
      take: 100,
    });
    if (candidates.length === 0) break;
    afterId = candidates[candidates.length - 1].id;

    for (const candidate of candidates) {
      try {
        const created = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw(Prisma.sql`
            SELECT "id" FROM "PurchaseOrder"
            WHERE "id" = ${candidate.id}
            FOR UPDATE
          `);
          const order = await tx.purchaseOrder.findUnique({
            where: { id: candidate.id },
          });
          if (!order || !REMINDABLE_STATUSES.includes(order.status) || !shouldSendReminder(order, now)) {
            return false;
          }
          const openIds = await collectReminderRecipientOpenIds(order);
          if (openIds.length === 0) return false;
          const eventKey = `procurement:stale:${order.id}:${order.statusEnteredAt.toISOString()}:${Math.floor(now.getTime() / REMINDER_INTERVAL_MS)}`;
          const result = await enqueueNotificationTx(tx, {
            eventKey,
            channel: "procurement",
            botKind: resolveProcurementBotKind(order.status),
            type: "scheduled_reminder",
            payload: {
              kind: "scheduled_reminder",
              orderId: order.id,
              expectedStatus: order.status,
              expectedStatusEnteredAt: order.statusEnteredAt.toISOString(),
              appOrigin: context?.appOrigin ?? null,
            } satisfies OrderOutboxPayload,
          });
          if (result.created) {
            await tx.purchaseOrder.update({
              where: { id: order.id },
              data: { lastReminderAt: now },
            });
          }
          return result.created;
        });
        if (created) enqueued++;
      } catch (error) {
        logger.error("procurement.reminder.order.failed", {
          module: "procurement",
          action: "runProcurementStaleReminders",
          entityType: "PurchaseOrder",
          entityId: candidate.id,
          orderNo: candidate.orderNo,
          result: "failure",
          error,
        });
      }
    }
  }

  if (enqueued > 0) drainNotificationOutboxSoon();
  return enqueued;
}

async function reserveManualReminderSlot(orderId: string): Promise<boolean> {
  const rateKey = `procurement:manual_reminder:${orderId}:${minuteBucket(new Date())}`;
  const reserved = await prisma.notificationOutbox.createMany({
    data: [
      {
        eventKey: rateKey,
        channel: "procurement",
        type: "manual_reminder",
        botKind: "notification",
        payload: JSON.stringify({ orderId }),
        status: "SENT",
        sentAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
  return reserved.count > 0;
}

export type ManualProcurementReminderResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/** 手动催促当前环节处理人（审批人，或待上传凭证环节的采购人） */
export async function sendManualProcurementApproverReminder({
  orderId,
  actorName,
  message,
  context,
}: {
  orderId: string;
  actorName: string;
  message?: string;
  context?: NotificationContext;
}): Promise<ManualProcurementReminderResult> {
  if (!(await reserveManualReminderSlot(orderId))) {
    return {
      ok: false,
      message: "刚刚已经催促过当前处理人，请稍后再试",
    };
  }

  const order = await prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) {
    return { ok: false, message: "订单不存在" };
  }

  const payload = toReminderOrderCardPayload(order);
  const enrichedOrder = await enrichOrderCardPayloadFromDb(payload);
  const stuckDays = daysStuck(order.statusEnteredAt);
  const statusLabel = statusLabels[order.status];
  const remindingApplicant = order.status === "PENDING_APPLICANT_DOCS";
  const extraLines = [
    `**催促人**：${actorName}`,
    ...(message ? [`**补充说明**：${message}`] : []),
    `**当前环节**：${statusLabel}`,
    ...(stuckDays > 0 ? [`**已停留**：${stuckDays} 天`] : []),
    remindingApplicant
      ? "**请尽快上传报销凭证，避免影响报销进度**"
      : "**请尽快处理，避免影响报销进度**",
  ];

  const card = await buildReminderCard(enrichedOrder, context, {
    headerTitle: "采购催促提醒",
    extraLines,
  });

  const deliveryCount = remindingApplicant
    ? await notifyInitiatorStale(
        order.id,
        card,
        resolveProcurementBotKind(order.status),
      )
    : await deliverApproverReminderCard(
        {
          ...payload,
          teamApproved: order.teamApproved,
          techGroupApproved: order.techGroupApproved,
        },
        card,
      );
  if (deliveryCount === 0) {
    return {
      ok: false,
      message: remindingApplicant
        ? "当前无法催促采购人，请稍后重试"
        : "当前环节没有可催促的审批人",
    };
  }

  if (order.status === "TEACHER_REVIEW") {
    await sendTeacherReviewEmailsOnce(
      enrichedOrder,
      order.statusEnteredAt,
      context,
      `procurement:manual_reminder:${order.id}:${Date.now()}`,
    );
    drainNotificationOutboxSoon();
  }

  return {
    ok: true,
    message: remindingApplicant ? "已催促采购人上传凭证" : "已催促当前审批人",
  };
}

async function deliverApproverReminderCard(
  order: OrderCardPayload & {
    teamApproved: boolean;
    techGroupApproved: boolean;
  },
  card: Record<string, unknown>,
): Promise<number> {
  if (order.status === "MANAGEMENT_REVIEW") {
    const tasks: Promise<number>[] = [];
    if (!order.teamApproved) {
      tasks.push(notifyRoleStale("TEAM_ADMIN", order, card));
    }
    if (!order.techGroupApproved) {
      tasks.push(notifyRoleStale("TECH_GROUP_ADMIN", order, card));
    }
    const counts = await Promise.all(tasks);
    return counts.reduce((total, count) => total + count, 0);
  }

  const role = statusApproverRole[order.status];
  if (role) {
    return notifyRoleStale(role, order, card);
  }
  return 0;
}
