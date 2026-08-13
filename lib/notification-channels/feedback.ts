import type { NotificationOutbox } from "@prisma/client";
import { z } from "zod";
import { defaultAppOrigin } from "@/lib/app-origin";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import {
  getFeedbackSuperAdminOpenIds,
  sendFeedbackCreatedNotification,
  sendFeedbackCreatedNotificationToOpenId,
  sendFeedbackReplyNotification,
  sendFeedbackReplyNotificationToOpenId,
  sendFeedbackStatusNotification,
  sendFeedbackStatusNotificationToOpenId,
  type FeedbackCreatedNotificationPayload,
  type FeedbackReplyNotificationPayload,
  type FeedbackStatusNotificationPayload,
} from "@/lib/feishu-feedback";
import type {
  NotificationChannelAdapter,
  NotificationDeliveryTarget,
} from "@/lib/notification-channel-adapter";
import { NonRetryableNotificationError } from "@/lib/notification-channel-adapter";

const appOriginSchema = z.string().nullable().optional();
const feedbackOutboxPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("created"),
    payload: z.object({
      feedbackId: z.string().min(1),
      submitterName: z.string(),
      body: z.string(),
    }),
    appOrigin: appOriginSchema,
  }),
  z.object({
    kind: z.literal("reply"),
    payload: z.object({
      feedbackId: z.string().min(1),
      actorName: z.string(),
      body: z.string(),
      recipientOpenIds: z.array(z.string()).optional(),
      actorIsAdmin: z.boolean(),
    }),
    appOrigin: appOriginSchema,
  }),
  z.object({
    kind: z.literal("status"),
    payload: z.object({
      feedbackId: z.string().min(1),
      actorName: z.string(),
      status: z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]),
      submitterOpenId: z.string().min(1),
    }),
    appOrigin: appOriginSchema,
  }),
]);

export type FeedbackOutboxPayload =
  | {
      kind: "created";
      payload: FeedbackCreatedNotificationPayload;
      appOrigin?: string | null;
    }
  | {
      kind: "reply";
      payload: FeedbackReplyNotificationPayload;
      appOrigin?: string | null;
    }
  | {
      kind: "status";
      payload: FeedbackStatusNotificationPayload;
      appOrigin?: string | null;
    };

function parseRow(row: NotificationOutbox): {
  data: FeedbackOutboxPayload;
  botKind: FeishuBotKind;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.payload);
  } catch {
    throw new NonRetryableNotificationError("反馈通知 payload 不是有效 JSON");
  }
  const result = feedbackOutboxPayloadSchema.safeParse(decoded);
  if (!result.success) {
    throw new NonRetryableNotificationError("反馈通知 payload 不符合持久化契约");
  }
  const data = result.data as FeedbackOutboxPayload;
  if (row.type !== data.kind) {
    throw new NonRetryableNotificationError(
      `反馈通知元数据不一致：type=${row.type}，payload.kind=${data.kind}`,
    );
  }
  if (row.botKind !== "notification" && row.botKind !== "approval") {
    throw new NonRetryableNotificationError(
      `反馈通知机器人类型无效：${row.botKind}`,
    );
  }
  if (row.botKind === "approval") {
    throw new NonRetryableNotificationError("反馈通知不得使用审批机器人");
  }
  return { data, botKind: "notification" };
}

function deliveryTarget(
  result: Awaited<
    ReturnType<typeof sendFeedbackCreatedNotificationToOpenId>
  >,
): NotificationDeliveryTarget {
  if (result.status === "skipped") {
    throw new Error(`FEISHU_DELIVERY_SKIPPED: ${result.reason}`);
  }
  return {
    receiveId: result.receiveId,
    receiveIdType: result.receiveIdType,
  };
}

export const feedbackNotificationChannel: NotificationChannelAdapter = {
  channel: "feedback",
  async resolveRecipientPlan(row) {
    const { data } = parseRow(row);
    if (data.kind === "created") {
      return {
        supported: true,
        openIds: await getFeedbackSuperAdminOpenIds(),
      };
    }
    if (data.kind === "reply") {
      return {
        supported: true,
        openIds: data.payload.actorIsAdmin
          ? [...new Set(data.payload.recipientOpenIds ?? [])]
          : await getFeedbackSuperAdminOpenIds(),
      };
    }
    return { supported: true, openIds: [data.payload.submitterOpenId] };
  },
  async sendToRecipient(row, recipientOpenId) {
    const { data, botKind } = parseRow(row);
    const context = { appOrigin: data.appOrigin ?? defaultAppOrigin() };
    if (data.kind === "created") {
      return deliveryTarget(
        await sendFeedbackCreatedNotificationToOpenId(
          data.payload,
          recipientOpenId,
          context,
          botKind,
        ),
      );
    }
    if (data.kind === "reply") {
      return deliveryTarget(
        await sendFeedbackReplyNotificationToOpenId(
          data.payload,
          recipientOpenId,
          context,
          botKind,
        ),
      );
    }
    return deliveryTarget(
      await sendFeedbackStatusNotificationToOpenId(
        data.payload,
        recipientOpenId,
        context,
        botKind,
      ),
    );
  },
  async sendComposite(row) {
    const { data, botKind } = parseRow(row);
    const context = { appOrigin: data.appOrigin ?? defaultAppOrigin() };
    if (data.kind === "created") {
      await sendFeedbackCreatedNotification(data.payload, context, botKind);
      return;
    }
    if (data.kind === "reply") {
      await sendFeedbackReplyNotification(data.payload, context, botKind);
      return;
    }
    await sendFeedbackStatusNotification(data.payload, context, botKind);
  },
};
