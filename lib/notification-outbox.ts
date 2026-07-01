import type {
  FeedbackStatus,
  NotificationOutbox,
  NotificationOutboxRecipient,
  Prisma,
} from "@prisma/client";
import {
  resolveProcurementBotKind,
  resolveProgressBotKind,
} from "@/lib/feishu-bot-routing";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import {
  sendApplicantResubmitNotification,
  sendBudgetThresholdNotification,
  collectOrderNotificationRecipientOpenIds,
  PROCUREMENT_ORDER_WEBHOOK_RECIPIENT_OPEN_ID,
  sendOrderNotification,
  sendOrderNotificationToOpenId,
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
  sendProgressNotificationToOpenId,
  type ProgressNotifyPayload,
} from "@/lib/feishu-progress";
import { isFeishuDirectMessageAllowed } from "@/lib/feishu-delivery-guard";
import { resolveDirectMessageTarget } from "@/lib/feishu-recipient";
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
const RECIPIENT_LOCK_MS = 2 * 60 * 1000;
const FROZEN_NEXT_RUN_AT = new Date("9999-12-31T00:00:00.000Z");

type DrainNotificationOutboxOptions = {
  ignoreDeliveryDisabled?: boolean;
};

type OutboxRecipientPlan =
  | {
      supported: true;
      openIds: string[];
    }
  | {
      supported: false;
    };

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
  return prisma.$transaction(async (tx) => {
    const updated = await tx.notificationOutbox.updateMany({
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
    if (updated.count === 1) {
      await tx.notificationOutboxRecipient.updateMany({
        where: {
          outboxId: id,
          status: { not: "SENT" },
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
    return updated;
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

export function orderNotificationEventKey(order: {
  id: string;
  status: string;
  statusEnteredAt: Date;
}): string {
  return `procurement:order:${order.id}:${order.status}:${order.statusEnteredAt.toISOString()}`;
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

export async function drainNotificationOutbox(
  limit = 20,
  options: DrainNotificationOutboxOptions = {},
): Promise<number> {
  if (NOTIFICATION_DELIVERY_DISABLED && !options.ignoreDeliveryDisabled) return 0;
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
    const lockedUntil = new Date(Date.now() + RECIPIENT_LOCK_MS);
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
      const recipientResult = await sendOutboxNotificationByRecipient(row);
      if (recipientResult.supported) {
        if (recipientResult.completed) sent++;
      } else {
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
      }
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

async function sendOutboxNotificationByRecipient(
  row: NotificationOutbox,
): Promise<{ supported: true; completed: boolean } | { supported: false }> {
  const plan = await resolveOutboxRecipientPlan(row);
  if (!plan.supported) return { supported: false };

  if (
    row.status === "FAILED" &&
    row.attempts > 0 &&
    isLegacyProjectEstablishmentRequestedEventKey(row.eventKey)
  ) {
    await freezeLegacyCompositeOutbox(row.id);
    return { supported: true, completed: false };
  }

  const existingRecipientCount = await prisma.notificationOutboxRecipient.count({
    where: { outboxId: row.id },
  });
  if (
    existingRecipientCount === 0 &&
    row.status === "FAILED" &&
    row.attempts > 0
  ) {
    await freezeLegacyCompositeOutbox(row.id);
    return { supported: true, completed: false };
  }

  await ensureOutboxRecipients(row.id, plan.openIds);

  const now = new Date();
  const recipients = await prisma.notificationOutboxRecipient.findMany({
    where: {
      outboxId: row.id,
      attempts: { lt: MAX_ATTEMPTS },
      OR: [
        { status: { in: ["PENDING", "FAILED"] }, nextRunAt: { lte: now } },
        { status: "PROCESSING", lockedUntil: { lte: now } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  for (const recipient of recipients) {
    await sendOutboxRecipient(row, recipient);
  }

  const summary = await updateOutboxStatusFromRecipients(row.id);
  return { supported: true, completed: summary.completed };
}

async function freezeLegacyCompositeOutbox(outboxId: string) {
  await prisma.notificationOutbox.updateMany({
    where: { id: outboxId, status: "PROCESSING" },
    data: {
      status: "FAILED",
      attempts: MAX_ATTEMPTS,
      nextRunAt: FROZEN_NEXT_RUN_AT,
      lockedUntil: null,
      lastError:
        "历史审批 outbox 已停止自动重试：该记录使用旧幂等 key 或在收件人级状态上线前已失败，可能已有部分收件人收到；请人工确认后再处理。",
    },
  });
}

function isLegacyProjectEstablishmentRequestedEventKey(eventKey: string): boolean {
  return /^progress:project_establishment_requested:[^:]+:\d{4}-\d{2}-\d{2}T/.test(
    eventKey,
  );
}

async function sendOutboxRecipient(
  row: NotificationOutbox,
  recipient: NotificationOutboxRecipient,
) {
  const lockedUntil = new Date(Date.now() + RECIPIENT_LOCK_MS);
  const claimed = await prisma.notificationOutboxRecipient.updateMany({
    where: {
      id: recipient.id,
      status: recipient.status,
      attempts: recipient.attempts,
    },
    data: {
      status: "PROCESSING",
      attempts: { increment: 1 },
      lockedUntil,
      lastError: "",
    },
  });
  if (claimed.count !== 1) return;

  const attempts = recipient.attempts + 1;
  try {
    const target = await sendOutboxNotificationToRecipient(row, recipient.openId);
    await prisma.notificationOutboxRecipient.updateMany({
      where: { id: recipient.id, status: "PROCESSING" },
      data: {
        status: "SENT",
        receiveId: target?.receiveId ?? recipient.receiveId,
        receiveIdType: target?.receiveIdType ?? recipient.receiveIdType,
        sentAt: new Date(),
        lastError: "",
        lockedUntil: null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.notificationOutboxRecipient.updateMany({
      where: { id: recipient.id, status: "PROCESSING" },
      data: {
        status: "FAILED",
        attempts,
        lastError: message.slice(0, 1000),
        nextRunAt: nextRetryAt(attempts),
        lockedUntil: null,
      },
    });
  }
}

async function sendOutboxNotificationToRecipient(
  row: NotificationOutbox,
  openId: string,
): Promise<{ receiveId: string; receiveIdType: string } | null> {
  const botKind = normalizeBotKind(row.botKind);
  const target = await resolveRecipientTarget(openId, botKind);
  if (target.skipped) return null;

  if (row.channel === "progress") {
    const data = JSON.parse(row.payload) as ProgressOutboxPayload;
    await sendProgressNotificationToOpenId(
      data.payload,
      openId,
      { appOrigin: data.appOrigin ?? undefined },
      botKind,
    );
    return target.target;
  }

  if (row.channel === "procurement") {
    const data = JSON.parse(row.payload) as OrderOutboxPayload;
    const context = {
      appOrigin: data.appOrigin ?? defaultAppOrigin(),
    };
    if (data.kind === "order") {
      await sendOrderNotificationToOpenId(data.order, openId, context, botKind);
      return target.target;
    }
    if (data.kind === "budget_threshold") {
      await sendBudgetThresholdNotification(
        { ...data.budget, recipientOpenIds: [openId] },
        context,
        botKind,
      );
      return target.target;
    }
  }

  throw new Error(`通知通道 ${row.channel}/${row.type} 不支持收件人级发送`);
}

async function resolveRecipientTarget(
  openId: string,
  botKind: FeishuBotKind,
): Promise<
  | { skipped: true; target: null }
  | { skipped: false; target: { receiveId: string; receiveIdType: string } | null }
> {
  if (openId === PROCUREMENT_ORDER_WEBHOOK_RECIPIENT_OPEN_ID) {
    return { skipped: false, target: null };
  }
  if (!(await isFeishuDirectMessageAllowed(openId))) {
    return { skipped: true, target: null };
  }
  return {
    skipped: false,
    target: await resolveDirectMessageTarget(openId, botKind),
  };
}

async function ensureOutboxRecipients(outboxId: string, openIds: string[]) {
  const uniqueOpenIds = [...new Set(openIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueOpenIds.length === 0) return;

  await prisma.notificationOutboxRecipient.createMany({
    data: uniqueOpenIds.map((openId) => ({
      outboxId,
      openId,
      status: "PENDING",
      attempts: 0,
      lastError: "",
      nextRunAt: new Date(),
    })),
    skipDuplicates: true,
  });
}

async function updateOutboxStatusFromRecipients(outboxId: string): Promise<{
  completed: boolean;
}> {
  const recipients = await prisma.notificationOutboxRecipient.findMany({
    where: { outboxId },
    select: {
      status: true,
      attempts: true,
      lastError: true,
      nextRunAt: true,
      lockedUntil: true,
    },
  });

  if (recipients.length === 0 || recipients.every((item) => item.status === "SENT")) {
    await prisma.notificationOutbox.updateMany({
      where: { id: outboxId, status: "PROCESSING" },
      data: {
        status: "SENT",
        sentAt: new Date(),
        lastError: "",
        lockedUntil: null,
      },
    });
    return { completed: true };
  }

  const retryableRecipients = recipients.filter(
    (item) => item.status !== "SENT" && item.attempts < MAX_ATTEMPTS,
  );
  const now = new Date();
  const nextRunAt =
    retryableRecipients
      .map((item) =>
        item.status === "PROCESSING" &&
        item.lockedUntil &&
        item.lockedUntil > now
          ? item.lockedUntil
          : item.nextRunAt,
      )
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? nextRetryAt(MAX_ATTEMPTS);
  const failedCount = recipients.filter((item) => item.status === "FAILED").length;
  const processingCount = recipients.filter(
    (item) => item.status === "PROCESSING",
  ).length;
  const firstError =
    recipients.find((item) => item.lastError.trim().length > 0)?.lastError ?? "";

  await prisma.notificationOutbox.updateMany({
    where: { id: outboxId, status: "PROCESSING" },
    data: {
      status: "FAILED",
      lastError: [
        `收件人发送未全部成功：${failedCount} 个失败，${processingCount} 个处理中`,
        firstError,
      ]
        .filter(Boolean)
        .join("；")
        .slice(0, 1000),
      nextRunAt,
      lockedUntil: null,
    },
  });
  return { completed: false };
}

async function resolveOutboxRecipientPlan(
  row: NotificationOutbox,
): Promise<OutboxRecipientPlan> {
  if (row.channel === "progress") {
    const data = JSON.parse(row.payload) as ProgressOutboxPayload;
    const openIds = extractProgressRecipientOpenIds(data.payload);
    return openIds ? { supported: true, openIds } : { supported: false };
  }

  if (row.channel === "procurement") {
    const data = JSON.parse(row.payload) as OrderOutboxPayload;
    if (data.kind === "order") {
      const openIds = await collectOrderNotificationRecipientOpenIds(data.order);
      if (
        data.order.status !== "PENDING_APPLICANT_DOCS" &&
        data.order.status !== "PENDING_APPLICANT_CONFIRM"
      ) {
        openIds.unshift(PROCUREMENT_ORDER_WEBHOOK_RECIPIENT_OPEN_ID);
      }
      return { supported: true, openIds };
    }
    if (data.kind === "budget_threshold") {
      return { supported: true, openIds: data.budget.recipientOpenIds };
    }
  }

  return { supported: false };
}

function extractProgressRecipientOpenIds(
  payload: ProgressNotifyPayload,
): string[] | null {
  const directRecipients = readRecipientOpenIds(payload);
  if (directRecipients) {
    return excludeRequesterForApprovalRequest(payload, directRecipients);
  }

  if (payload.type === "project_establishment_rejected") {
    return [payload.requesterOpenId];
  }
  if (payload.type === "task_creation_rejected") {
    return [payload.requesterOpenId];
  }

  return null;
}

function readRecipientOpenIds(payload: ProgressNotifyPayload): string[] | null {
  if (!("recipientOpenIds" in payload)) return null;
  return Array.isArray(payload.recipientOpenIds)
    ? payload.recipientOpenIds.filter((openId): openId is string => typeof openId === "string")
    : [];
}

function excludeRequesterForApprovalRequest(
  payload: ProgressNotifyPayload,
  openIds: string[],
): string[] {
  if (
    payload.type !== "project_stage_extension_requested" &&
    payload.type !== "project_stage_batch_due_change_requested" &&
    payload.type !== "project_stage_due_change_requested"
  ) {
    return openIds;
  }
  return openIds.filter((openId) => openId !== payload.requesterOpenId);
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
