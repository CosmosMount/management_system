import type { NotificationOutbox } from "@prisma/client";
import { buildAppUrl } from "@/lib/app-origin";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import {
  sendFeishuDirectMessage,
  type FeishuSendResult,
} from "@/lib/feishu-message";
import {
  PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
  projectManagementNotificationPayloadSchema,
  type ProjectManagementNotificationPayload,
} from "@/lib/project-management/notifications/contract";
import type {
  NotificationChannelAdapter,
  NotificationDeliveryTarget,
} from "@/lib/notification-channel-adapter";
import { NonRetryableNotificationError } from "@/lib/notification-channel-adapter";

function parseProjectManagementNotification(row: NotificationOutbox): {
  payload: ProjectManagementNotificationPayload;
  botKind: FeishuBotKind;
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.payload);
  } catch {
    throw new NonRetryableNotificationError(
      "项目管理通知 payload 不是有效 JSON",
    );
  }
  const result = projectManagementNotificationPayloadSchema.safeParse(decoded);
  if (!result.success) {
    throw new NonRetryableNotificationError(
      "项目管理通知 payload 不符合持久化契约",
    );
  }
  const payload = result.data;
  if (row.type !== payload.kind) {
    throw new NonRetryableNotificationError(
      `项目管理通知元数据不一致：type=${row.type}，payload.kind=${payload.kind}`,
    );
  }
  const expectedBotKind =
    payload.purpose === "approval_request" ? "approval" : "notification";
  if (row.botKind !== expectedBotKind) {
    throw new NonRetryableNotificationError(
      `项目管理通知机器人类型无效：${payload.kind} 应使用 ${expectedBotKind}`,
    );
  }
  return { payload, botKind: expectedBotKind };
}

export const projectManagementNotificationChannel: NotificationChannelAdapter = {
  channel: PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
  async resolveRecipientPlan(row) {
    const { payload } = parseProjectManagementNotification(row);
    const openIds = uniqueOpenIds(payload);
    return {
      supported: true,
      openIds,
      directOpenIds: openIds,
      requiresDirectRecipient: payload.purpose === "approval_request",
    };
  },
  async sendToRecipient(
    row,
    recipientOpenId,
  ): Promise<NotificationDeliveryTarget> {
    const { payload, botKind } = parseProjectManagementNotification(row);
    return deliveryTarget(
      await sendFeishuDirectMessage({
        recipientOpenId,
        botKind,
        purpose: payload.purpose,
        message: {
          type: "interactive",
          card: buildProjectManagementCard(payload, row.createdAt),
        },
        logContext: {
          action: "sendProjectManagementNotification",
          channel: PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
          eventKey: row.eventKey,
          entityType: payload.entityType,
          entityId: payload.entityId,
        },
      }),
    );
  },
  async sendComposite(row) {
    const { payload, botKind } = parseProjectManagementNotification(row);
    const card = buildProjectManagementCard(payload, row.createdAt);
    const recipients = uniqueOpenIds(payload);
    const results = await Promise.allSettled(
      recipients.map((recipientOpenId) =>
        sendFeishuDirectMessage({
          recipientOpenId,
          botKind,
          purpose: payload.purpose,
          message: { type: "interactive", card },
          logContext: {
            action: "sendProjectManagementNotificationComposite",
            channel: PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
            eventKey: row.eventKey,
            entityType: payload.entityType,
            entityId: payload.entityId,
          },
        }),
      ),
    );
    const failed = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed.length > 0) {
      const reason = failed[0]?.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      throw new Error(
        `项目管理飞书通知失败：${failed.length}/${results.length} 个收件人失败；${message}`,
      );
    }
  },
};

function uniqueOpenIds(payload: ProjectManagementNotificationPayload): string[] {
  return [
    ...new Set(
      payload.recipientOpenIds.map((openId) => openId.trim()).filter(Boolean),
    ),
  ];
}

function deliveryTarget(result: FeishuSendResult): NotificationDeliveryTarget {
  if (result.status === "skipped") {
    throw new Error(`FEISHU_DELIVERY_SKIPPED: ${result.reason}`);
  }
  return {
    receiveId: result.receiveId,
    receiveIdType: result.receiveIdType,
  };
}

function buildProjectManagementCard(
  payload: ProjectManagementNotificationPayload,
  createdAt: Date,
) {
  const url = buildAppUrl(payload.linkPath || "/progress", payload.appOrigin);
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: truncate(payload.title, 80) },
      template: cardTemplate(payload),
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**操作人**：${payload.actorName || "系统"}`,
            payload.projectName ? `**Project**：${truncate(payload.projectName, 80)}` : null,
            payload.taskTitle ? `**Task**：${truncate(payload.taskTitle, 80)}` : null,
            `**事件**：${truncate(payload.summary || payload.title, 180)}`,
            `**对象**：${payload.entityType}`,
            `**时间**：${formatCardDate(createdAt)}`,
            contextText(payload.context),
          ]
            .filter((line): line is string => Boolean(line))
            .join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "打开系统处理" },
            url,
            type: payload.purpose === "approval_request" ? "primary" : "default",
          },
        ],
      },
    ],
  };
}

function cardTemplate(payload: ProjectManagementNotificationPayload) {
  if (payload.purpose === "approval_request") return "orange";
  if (payload.category === "ACCOUNT_SECURITY") return "red";
  if (payload.category === "WORK_SEGMENT") return "blue";
  return payload.mandatory ? "orange" : "green";
}

function contextText(context: Record<string, unknown>) {
  const entries = Object.entries(context)
    .filter(
      ([key, value]) =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        !isInternalContextKey(key),
    )
    .slice(0, 6);
  if (entries.length === 0) return null;
  return entries
    .map(
      ([key, value]) =>
        `**${contextLabel(key)}**：${truncate(
          contextValue(key, value),
          key === "content" ? 2_000 : key === "resolveNote" ? 500 : 80,
        )}`,
    )
    .join("\n");
}

function isInternalContextKey(key: string) {
  return key === "lockVersion" || key.endsWith("Id") || key.endsWith("Ids");
}

function contextValue(key: string, value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join("、");
  }
  if (key === "beforeStatus" || key === "afterStatus" || key === "taskStatus") {
    return statusLabel(String(value));
  }
  if (key === "decision") {
    return value === "APPROVED" ? "通过" : value === "REJECTED" ? "驳回" : String(value);
  }
  if (key === "role") {
    return value === "OWNER" ? "负责人" : value === "PARTICIPANT" ? "参与人" : String(value);
  }
  return String(value);
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    DRAFT: "草稿",
    PENDING_APPROVAL: "立项审批中",
    ACTIVE: "进行中",
    COMPLETED: "已完成",
    FAILED: "失败",
    CANCELLED: "已取消",
    TIMEOUT: "超时",
    ARCHIVED: "已归档",
    DELETED: "已删除",
  };
  return labels[value] ?? value;
}

function contextLabel(key: string) {
  const labels: Record<string, string> = {
    taskStatus: "Task 状态",
    segmentStatus: "投入状态",
    beforeStatus: "变更前状态",
    afterStatus: "变更后状态",
    round: "立项轮次",
    ownerNames: "负责人",
    taskCount: "Task 数量",
    decision: "审批结果",
    comment: "审批意见",
    role: "成员角色",
    content: "内容",
    resolveNote: "解决说明",
  };
  return labels[key] ?? key;
}

function truncate(value: string, maxLength: number) {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function formatCardDate(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
