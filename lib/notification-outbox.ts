import type { FeedbackStatus, NotificationOutbox, Prisma } from "@prisma/client";
import {
  resolveProcurementBotKind,
  resolveProgressBotKind,
} from "@/lib/feishu-bot-routing";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import {
  sendApplicantResubmitNotification,
  sendBudgetThresholdNotification,
  sendOrderNotification,
  sendProcurementRejectedNotification,
  sendProcurementReturnDraftNotification,
  type BudgetThresholdPayload,
  type OrderCardPayload,
} from "@/lib/feishu";
import {
  sendFeedbackCreatedNotification,
  sendFeedbackReplyNotification,
  sendFeedbackStatusNotification,
} from "@/lib/feishu-feedback";
import {
  sendProgressNotification,
  type ProgressNotifyPayload,
} from "@/lib/feishu-progress";
import type { NotificationContext } from "@/lib/app-origin";
import { defaultAppOrigin } from "@/lib/app-origin";
import { prisma } from "@/lib/prisma";

type ProgressOutboxPayload = {
  payload: ProgressNotifyPayload;
  appOrigin?: string | null;
};

type OrderOutboxPayload =
  | {
      kind: "order";
      order: OrderCardPayload;
      appOrigin?: string | null;
    }
  | {
      kind: "procurement_rejected";
      order: OrderCardPayload;
      reason: string;
      rejectedByName: string;
      appOrigin?: string | null;
    }
  | {
      kind: "applicant_resubmit";
      order: OrderCardPayload;
      reason: string;
      financeName: string;
      appOrigin?: string | null;
    }
  | {
      kind: "procurement_return_draft";
      order: OrderCardPayload;
      reason: string;
      returnedByName: string;
      appOrigin?: string | null;
    }
  | {
      kind: "budget_threshold";
      budget: BudgetThresholdPayload;
      appOrigin?: string | null;
    };

type FeedbackOutboxPayload =
  | {
      kind: "created";
      payload: { feedbackId: string; submitterName: string; body: string };
      appOrigin?: string | null;
    }
  | {
      kind: "reply";
      payload: {
        feedbackId: string;
        actorName: string;
        body: string;
        recipientOpenIds?: string[];
        actorIsAdmin: boolean;
      };
      appOrigin?: string | null;
    }
  | {
      kind: "status";
      payload: {
        feedbackId: string;
        actorName: string;
        status: FeedbackStatus;
        submitterOpenId: string;
      };
      appOrigin?: string | null;
    };

const MAX_ATTEMPTS = 8;
const NOTIFICATION_DELIVERY_DISABLED =
  process.env.NOTIFICATION_DELIVERY_DISABLED === "true";

export type EnqueueNotificationResult = {
  created: boolean;
};

export async function enqueueNotification({
  eventKey,
  channel,
  botKind = "notification",
  type,
  payload,
}: {
  eventKey: string;
  channel: string;
  botKind?: FeishuBotKind;
  type: string;
  payload: unknown;
}): Promise<EnqueueNotificationResult> {
  const payloadText = JSON.stringify(payload);
  const result = await prisma.notificationOutbox.createMany({
    data: [
      {
        eventKey,
        channel,
        botKind,
        type,
        payload: payloadText,
        status: "PENDING",
        attempts: 0,
        lastError: "",
        nextRunAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
  return { created: result.count > 0 };
}

export async function enqueueNotificationTx(
  tx: Prisma.TransactionClient,
  {
    eventKey,
    channel,
    botKind = "notification",
    type,
    payload,
  }: {
    eventKey: string;
    channel: string;
    botKind?: FeishuBotKind;
    type: string;
    payload: unknown;
  },
): Promise<EnqueueNotificationResult> {
  const payloadText = JSON.stringify(payload);
  const result = await tx.notificationOutbox.createMany({
    data: [
      {
        eventKey,
        channel,
        botKind,
        type,
        payload: payloadText,
        status: "PENDING",
        attempts: 0,
        lastError: "",
        nextRunAt: new Date(),
      },
    ],
    skipDuplicates: true,
  });
  return { created: result.count > 0 };
}

export async function resetNotificationOutboxForRetry({
  id,
  channel,
  type,
}: {
  id: string;
  channel: string;
  type: string;
}) {
  return prisma.notificationOutbox.updateMany({
    where: {
      id,
      channel,
      type,
      status: "FAILED",
    },
    data: {
      status: "PENDING",
      attempts: 0,
      nextRunAt: new Date(),
      lockedUntil: null,
      lastError: "",
    },
  });
}

export async function enqueueProgressNotification(
  eventKey: string,
  payload: ProgressNotifyPayload,
  context?: NotificationContext,
) {
  return enqueueNotification({
    eventKey,
    channel: "progress",
    botKind: resolveProgressBotKind(payload.type),
    type: payload.type,
    payload: {
      payload,
      appOrigin: context?.appOrigin ?? null,
    } satisfies ProgressOutboxPayload,
  });
}

export async function enqueueProgressNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  payload: ProgressNotifyPayload,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
    eventKey,
    channel: "progress",
    botKind: resolveProgressBotKind(payload.type),
    type: payload.type,
    payload: {
      payload,
      appOrigin: context?.appOrigin ?? null,
    } satisfies ProgressOutboxPayload,
  });
}

export async function enqueueOrderNotification(
  eventKey: string,
  order: OrderCardPayload,
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "procurement",
    botKind: resolveProcurementBotKind(order.status),
    type: "order",
    payload: {
      kind: "order",
      order,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueOrderNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  order: OrderCardPayload,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
    eventKey,
    channel: "procurement",
    botKind: resolveProcurementBotKind(order.status),
    type: "order",
    payload: {
      kind: "order",
      order,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueProcurementRejectedNotification(
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  rejectedByName: string,
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "procurement_rejected",
    payload: {
      kind: "procurement_rejected",
      order,
      reason,
      rejectedByName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueProcurementRejectedNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  rejectedByName: string,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "procurement_rejected",
    payload: {
      kind: "procurement_rejected",
      order,
      reason,
      rejectedByName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueApplicantResubmitNotification(
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  financeName: string,
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "applicant_resubmit",
    payload: {
      kind: "applicant_resubmit",
      order,
      reason,
      financeName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueProcurementReturnDraftNotification(
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  returnedByName: string,
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "procurement_return_draft",
    payload: {
      kind: "procurement_return_draft",
      order,
      reason,
      returnedByName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueProcurementReturnDraftNotificationTx(
  tx: Prisma.TransactionClient,
  eventKey: string,
  order: OrderCardPayload,
  reason: string,
  returnedByName: string,
  context?: NotificationContext,
) {
  return enqueueNotificationTx(tx, {
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "procurement_return_draft",
    payload: {
      kind: "procurement_return_draft",
      order,
      reason,
      returnedByName,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueBudgetThresholdNotification(
  eventKey: string,
  budget: BudgetThresholdPayload,
  context?: NotificationContext,
) {
  return enqueueNotification({
    eventKey,
    channel: "procurement",
    botKind: "notification",
    type: "budget_threshold",
    payload: {
      kind: "budget_threshold",
      budget,
      appOrigin: context?.appOrigin ?? null,
    } satisfies OrderOutboxPayload,
  });
}

export async function enqueueFeedbackCreatedNotification(
  eventKey: string,
  payload: Extract<FeedbackOutboxPayload, { kind: "created" }>["payload"],
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "feedback",
    botKind: "notification",
    type: "created",
    payload: {
      kind: "created",
      payload,
      appOrigin: context?.appOrigin ?? null,
    } satisfies FeedbackOutboxPayload,
  });
}

export async function enqueueFeedbackReplyNotification(
  eventKey: string,
  payload: Extract<FeedbackOutboxPayload, { kind: "reply" }>["payload"],
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "feedback",
    botKind: "notification",
    type: "reply",
    payload: {
      kind: "reply",
      payload,
      appOrigin: context?.appOrigin ?? null,
    } satisfies FeedbackOutboxPayload,
  });
}

export async function enqueueFeedbackStatusNotification(
  eventKey: string,
  payload: Extract<FeedbackOutboxPayload, { kind: "status" }>["payload"],
  context?: NotificationContext,
) {
  await enqueueNotification({
    eventKey,
    channel: "feedback",
    botKind: "notification",
    type: "status",
    payload: {
      kind: "status",
      payload,
      appOrigin: context?.appOrigin ?? null,
    } satisfies FeedbackOutboxPayload,
  });
}

export function drainNotificationOutboxSoon(limit = 5) {
  if (NOTIFICATION_DELIVERY_DISABLED) return;
  void drainNotificationOutbox(limit).catch((err) => {
    console.error("[notification-outbox] drain failed:", err);
  });
}

export async function drainNotificationOutbox(limit = 20): Promise<number> {
  if (NOTIFICATION_DELIVERY_DISABLED) return 0;
  const now = new Date();
  const rows = await prisma.notificationOutbox.findMany({
    where: {
      attempts: { lt: MAX_ATTEMPTS },
      OR: [
        { status: { in: ["PENDING", "FAILED"] }, nextRunAt: { lte: now } },
        { status: "PROCESSING", lockedUntil: { lte: now } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
  });

  let sent = 0;
  for (const row of rows) {
    const lockedUntil = new Date(Date.now() + 2 * 60 * 1000);
    const claimed = await prisma.notificationOutbox.updateMany({
      where: {
        id: row.id,
        status: row.status,
        attempts: row.attempts,
      },
      data: {
        status: "PROCESSING",
        attempts: { increment: 1 },
        lastError: "",
        lockedUntil,
      },
    });
    if (claimed.count !== 1) continue;

    try {
      await sendOutboxNotification(row);
      const markedSent = await prisma.notificationOutbox.updateMany({
        where: { id: row.id, status: "PROCESSING" },
        data: {
          status: "SENT",
          sentAt: new Date(),
          lastError: "",
          lockedUntil: null,
        },
      });
      if (markedSent.count === 1) sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;
      await prisma.notificationOutbox.updateMany({
        where: { id: row.id, status: "PROCESSING" },
        data: {
          status: "FAILED",
          lastError: message.slice(0, 1000),
          nextRunAt: nextRetryAt(attempts),
          lockedUntil: null,
        },
      });
    }
  }

  return sent;
}

async function sendOutboxNotification(row: NotificationOutbox) {
  const botKind = normalizeBotKind(row.botKind);
  if (row.channel === "progress") {
    const data = JSON.parse(row.payload) as ProgressOutboxPayload;
    await sendProgressNotification(data.payload, {
      appOrigin: data.appOrigin ?? undefined,
    }, botKind);
    return;
  }

  if (row.channel === "procurement") {
    const data = JSON.parse(row.payload) as OrderOutboxPayload;
    const context = {
      appOrigin: data.appOrigin ?? defaultAppOrigin(),
    };
    if (data.kind === "order") {
      await sendOrderNotification(data.order, context, botKind);
      return;
    }
    if (data.kind === "procurement_rejected") {
      await sendProcurementRejectedNotification(
        data.order,
        data.reason,
        data.rejectedByName,
        context,
        botKind,
      );
      return;
    }
    if (data.kind === "budget_threshold") {
      await sendBudgetThresholdNotification(data.budget, context, botKind);
      return;
    }
    if (data.kind === "procurement_return_draft") {
      await sendProcurementReturnDraftNotification(
        data.order,
        data.reason,
        data.returnedByName,
        context,
        botKind,
      );
      return;
    }
    await sendApplicantResubmitNotification(
      data.order,
      data.reason,
      data.financeName,
      context,
      botKind,
    );
    return;
  }

  if (row.channel === "feedback") {
    const data = JSON.parse(row.payload) as FeedbackOutboxPayload;
    const context = {
      appOrigin: data.appOrigin ?? defaultAppOrigin(),
    };
    if (data.kind === "created") {
      await sendFeedbackCreatedNotification(data.payload, context, botKind);
      return;
    }
    if (data.kind === "reply") {
      await sendFeedbackReplyNotification(data.payload, context, botKind);
      return;
    }
    await sendFeedbackStatusNotification(data.payload, context, botKind);
    return;
  }

  throw new Error(`未知通知通道: ${row.channel}`);
}

function normalizeBotKind(value: string): FeishuBotKind {
  return value === "approval" ? "approval" : "notification";
}

function nextRetryAt(attempts: number): Date {
  const delaySeconds = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + delaySeconds * 1000);
}
