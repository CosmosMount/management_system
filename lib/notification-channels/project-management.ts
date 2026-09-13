import type { NotificationOutbox } from "@prisma/client";
import { buildAppUrl } from "@/lib/app-origin";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import {
  sendFeishuDirectMessage,
  type FeishuSendResult,
} from "@/lib/feishu-message";
import {
  PROJECT_MANAGEMENT_NOTIFICATION_OUTBOX_CHANNEL,
  RETIRED_SEGMENT_NOTIFICATION_KIND,
  RETIRED_SEGMENT_NOTIFICATION_REASON,
  projectManagementNotificationPayloadSchema,
  type ProjectManagementNotificationPayload,
} from "@/lib/project-management/notifications/contract";
import {
  normalizeProjectManagementNotificationText,
  projectManagementContextLines,
  projectManagementEntityLabel,
  projectManagementStatusLabel,
} from "@/lib/project-management/notifications/user-facing-copy";
import { resolveProjectManagementNotificationLinkPath } from "@/lib/project-management/notifications/link-path";
import type {
  NotificationChannelAdapter,
  NotificationDeliveryTarget,
} from "@/lib/notification-channel-adapter";
import { NonRetryableNotificationError } from "@/lib/notification-channel-adapter";
import { CanceledNotificationError } from "@/lib/notification-channel-adapter";
import { filterActiveFeishuOpenIds } from "@/lib/active-account";
import { prisma } from "@/lib/prisma";

function parseProjectManagementNotification(row: NotificationOutbox): {
  payload: ProjectManagementNotificationPayload;
  botKind: FeishuBotKind;
} {
  if (row.type === RETIRED_SEGMENT_NOTIFICATION_KIND) {
    throw new CanceledNotificationError(RETIRED_SEGMENT_NOTIFICATION_REASON);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.payload);
  } catch {
    throw new NonRetryableNotificationError(
      "项目管理通知 payload 不是有效 JSON",
    );
  }
  if (
    decoded &&
    typeof decoded === "object" &&
    "kind" in decoded &&
    decoded.kind === RETIRED_SEGMENT_NOTIFICATION_KIND
  ) {
    throw new CanceledNotificationError(RETIRED_SEGMENT_NOTIFICATION_REASON);
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
    let payload: ProjectManagementNotificationPayload;
    try {
      ({ payload } = parseProjectManagementNotification(row));
    } catch (error) {
      if (error instanceof CanceledNotificationError) {
        return { supported: true, openIds: [], cancelReason: error.message };
      }
      throw error;
    }
    const cancelReason = await staleApprovalCancelReason(
      payload,
      row.eventKey,
    );
    if (cancelReason) {
      return {
        supported: true,
        openIds: [],
        cancelReason,
      };
    }
    const openIds = await eligibleSummaryRecipients(payload, await filterActiveFeishuOpenIds(uniqueOpenIds(payload)));
    return {
      supported: true,
      openIds,
      directOpenIds: openIds,
      requiresDirectRecipient: payload.purpose === "approval_request" || (payload.kind === "project_management_global_summary_daily" || payload.kind === "project_management_personal_summary_daily"),
    };
  },
  async sendToRecipient(
    row,
    recipientOpenId,
  ): Promise<NotificationDeliveryTarget> {
    const { payload, botKind } = parseProjectManagementNotification(row);
    if (!(await eligibleSummaryRecipients(payload, [recipientOpenId])).length) {
      throw new CanceledNotificationError("收件人已不再具有该总结的接收权限，取消总结投递");
    }
    if (
      (await filterActiveFeishuOpenIds([recipientOpenId])).length === 0
    ) {
      throw new CanceledNotificationError("收件人已停用，取消本次投递");
    }
    const cancelReason = await staleApprovalCancelReason(
      payload,
      row.eventKey,
    );
    if (cancelReason) {
      throw new CanceledNotificationError(cancelReason);
    }
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
    const recipients = await eligibleSummaryRecipients(payload, uniqueOpenIds(payload));
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

async function eligibleSummaryRecipients(payload: ProjectManagementNotificationPayload, openIds: string[]) {
  if (payload.kind === "project_management_personal_summary_daily") {
    const summary = await prisma.personalSummary.findUnique({
      where: { id: payload.entityId }, select: { accountId: true, requiresApprovalAdministrator: true },
    });
    if (!summary) return [];
    const identities = await prisma.accountIdentity.findMany({ where: {
      provider: "FEISHU", tenantId: "default", openId: { in: openIds }, accountId: summary.accountId,
      account: { person: { is: { status: "ACTIVE" } }, ...(summary.requiresApprovalAdministrator ? { systemRoles: { some: {
        role: { in: ["SUPER_ADMINISTRATOR" as const, "PROJECT_ADMINISTRATOR" as const] }, team: "", techGroup: "", revokedAt: null,
      } } } : {}) },
    }, select: { openId: true } });
    const allowed = new Set(identities.map((identity) => identity.openId));
    return openIds.filter((openId) => allowed.has(openId));
  }
  if (payload.kind !== "project_management_global_summary_daily") return openIds;
  const identities = await prisma.accountIdentity.findMany({ where: {
    provider: "FEISHU", tenantId: "default", openId: { in: openIds }, account: {
      person: { is: { status: "ACTIVE" } }, systemRoles: { some: {
        role: { in: ["SUPER_ADMINISTRATOR", "PROJECT_ADMINISTRATOR"] }, team: "", techGroup: "", revokedAt: null,
      } },
    },
  }, select: { openId: true } });
  const allowed = new Set(identities.map((identity) => identity.openId));
  return openIds.filter((openId) => allowed.has(openId));
}

async function staleApprovalCancelReason(
  payload: ProjectManagementNotificationPayload,
  eventKey: string,
) {
  if (payload.kind !== "revision_pending_review") return null;
  const revision = await prisma.revisionNode.findUnique({
    where: { id: payload.entityId },
    select: { status: true, reviewRound: true },
  });
  if (!revision || revision.status !== "PENDING_APPROVAL") {
    return "计划修订已不再等待审批，取消过期通知";
  }
  // Approval events created before reviewRound was persisted belong to round 1.
  // Treating an unknown round as the current one could revive an old approval
  // after a rejected Revision is resubmitted.
  const notifiedRound = revisionNotificationRound(payload, eventKey) ?? 1;
  if (notifiedRound !== revision.reviewRound) {
    return "计划修订审批轮次已更新，取消过期通知";
  }
  return null;
}

function revisionNotificationRound(
  payload: ProjectManagementNotificationPayload,
  eventKey: string,
) {
  const contextRound = payload.context.round;
  if (
    typeof contextRound === "number" &&
    Number.isSafeInteger(contextRound) &&
    contextRound > 0
  ) {
    return contextRound;
  }
  const eventRound = eventKey.match(/:round:(\d+)(?::feishu)?$/)?.[1];
  if (!eventRound) return null;
  const parsedRound = Number(eventRound);
  return Number.isSafeInteger(parsedRound) && parsedRound > 0
    ? parsedRound
    : null;
}

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

export function buildProjectManagementCard(
  payload: ProjectManagementNotificationPayload,
  createdAt: Date,
) {
  const url = buildAppUrl(
    resolveProjectManagementNotificationLinkPath({
      kind: payload.kind,
      linkPath: payload.linkPath,
      taskId: payload.taskId,
      projectId: payload.projectId,
    }),
    payload.appOrigin,
  );
  const title = normalizeProjectManagementNotificationText(payload.title, {
    field: "title",
    kind: payload.kind,
    taskTitle: payload.taskTitle,
    projectName: payload.projectName,
    actorName: payload.actorName,
    context: payload.context,
  });
  const summary = normalizeProjectManagementNotificationText(
    payload.summary || payload.title,
    {
      field: "summary",
      kind: payload.kind,
      taskTitle: payload.taskTitle,
      projectName: payload.projectName,
      actorName: payload.actorName,
      context: payload.context,
    },
  );
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: truncate(title, 80) },
      template: cardTemplate(payload),
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: payload.kind === "meeting_work_segment_reminder" || payload.kind === "task_urged" || (payload.kind === "project_management_global_summary_daily" || payload.kind === "project_management_personal_summary_daily") ? "plain_text" : "lark_md",
          content: payload.kind === "meeting_work_segment_reminder" ? `提醒人：${payload.actorName}\n${payload.summary}\n提醒时间：${formatCardDate(createdAt)}` : (payload.kind === "project_management_global_summary_daily" || payload.kind === "project_management_personal_summary_daily") ? payload.summary : payload.kind === "task_urged" ? [
            `催促人：${payload.actorName || "未知用户"}`,
            `项目：${payload.projectName || "未关联项目"}`,
            `任务：${payload.taskTitle || "任务"}`,
            `催促时状态：${projectManagementStatusLabel(String(payload.context.taskStatus))}`,
            `负责人：${Array.isArray(payload.context.ownerNames) && payload.context.ownerNames.length ? payload.context.ownerNames.join("、") : "暂无有效负责人"}`,
            `催促信息：${summary}`,
            `催促时间：${formatCardDate(createdAt)}`,
          ].join("\n") : [
            `**操作人**：${payload.actorName || "系统"}`,
            payload.projectName ? `**项目**：${truncate(payload.projectName, 80)}` : null,
            payload.taskTitle ? `**任务**：${truncate(payload.taskTitle, 80)}` : null,
            `**通知内容**：${truncate(summary, 180)}`,
            `**相关事项**：${projectManagementEntityLabel(payload.entityType)}`,
            `**通知时间**：${formatCardDate(createdAt)}`,
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
            text: {
              tag: "plain_text",
              content:
                payload.purpose === "approval_request"
                  ? "查看并审批"
                  : "查看详情",
            },
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
  const lines = projectManagementContextLines(context);
  if (lines.length === 0) return null;
  return lines
    .map(({ label, value, maxLength }) =>
      `**${label}**：${truncate(value, maxLength)}`,
    )
    .join("\n");
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
