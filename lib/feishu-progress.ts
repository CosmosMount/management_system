import { AsyncLocalStorage } from "node:async_hooks";
import { getFeishuTenantAccessTokenByBotKind } from "@/lib/feishu-auth";
import type { FeishuBotKind } from "@/lib/feishu-app-config";
import { resolveProgressBotKind } from "@/lib/feishu-bot-routing";
import { isFeishuDirectMessageAllowed } from "@/lib/feishu-delivery-guard";
import {
  resolveDirectMessageTarget,
  shouldFallbackApprovalBotUnavailable,
  type FeishuDirectMessageTarget,
} from "@/lib/feishu-recipient";
import { getOpenIdsByRole } from "@/lib/permissions";
import { buildAppUrl, type NotificationContext } from "@/lib/app-origin";
import type { Importance, TaskStatus, Urgency, UserRoleType } from "@prisma/client";
import { routes } from "@/lib/routes";
import {
  importanceLabels,
  projectStatusLabels,
  taskStatusLabels,
  urgencyLabels,
} from "@/lib/progress-labels";
import { logger } from "@/lib/logger";

const progressBotKindStorage = new AsyncLocalStorage<FeishuBotKind>();
const EXPLICIT_RECIPIENT_REQUIRED_TYPES = new Set<string>([
  "project_started",
  "project_completed",
  "project_canceled",
  "project_updated",
  "project_comment_created",
  "project_stage_rollback",
  "project_stage_extension_requested",
  "project_stage_batch_due_change_requested",
  "project_stage_extension_approved",
  "project_stage_extension_rejected",
  "project_stage_batch_due_change_approved",
  "project_stage_batch_due_change_rejected",
  "project_stage_due_change_requested",
  "project_stage_due_change_approved",
  "project_stage_due_change_rejected",
  "stage_pending_acceptance",
  "stage_approved",
  "stage_rejected",
  "task_assigned",
  "task_updated",
  "task_restarted",
  "task_delete_requested",
  "task_deleted",
  "task_delete_rejected",
  "task_creation_requested",
  "task_creation_approved",
  "task_creation_rejected",
  "task_bulk_imported",
  "task_bulk_creation_requested",
  "task_pending_acceptance",
  "task_risk_synced",
  "task_approved",
  "task_rejected",
  "task_overdue",
  "weekly_report_reminder",
  "progress_daily_summary",
]);

type TaskNotificationDetails = {
  stageName?: string | null;
  assigneeNames?: string;
  taskTechGroups?: string[];
  urgency?: Urgency;
  importance?: Importance;
  dueAt?: string;
  metrics?: string;
  goal?: string;
  needsWeeklyReport?: boolean;
  needsOfflineConfirmation?: boolean;
  acceptanceChecklistItems?: string[];
};

export type ProgressNotifyPayload =
  | {
      type: "project_establishment_requested";
      projectId: string;
      projectName: string;
      requesterName: string;
      requesterOpenId: string;
      team: string;
      techGroup: string;
      ownerNames: string;
      participantNames?: string;
      stageCount: number;
      recipientOpenIds: string[];
    }
  | {
      type: "project_establishment_approved";
      projectId: string;
      projectName: string;
      requesterOpenId: string;
      requesterName: string;
      reviewerName: string;
      comment: string;
      team: string;
      techGroup: string;
      ownerOpenIds: string[];
      ownerNames: string;
      participantOpenIds?: string[];
      participantNames?: string;
      stageCount: number;
      recipientOpenIds: string[];
    }
  | {
      type: "project_establishment_rejected";
      projectId: string;
      projectName: string;
      requesterOpenId: string;
      requesterName: string;
      reviewerName: string;
      comment: string;
      team: string;
      techGroup: string;
      recipientOpenIds: string[];
    }
  | {
      type: "project_started" | "project_completed" | "project_canceled";
      projectId: string;
      projectName: string;
      team: string;
      techGroup: string;
      ownerOpenIds: string[];
      ownerNames: string;
      participantOpenIds?: string[];
      participantNames?: string;
      recipientOpenIds?: string[];
      canceledTaskCount?: number;
    }
  | {
      type: "project_followed" | "project_unfollowed";
      projectId: string;
      projectName: string;
      actorName: string;
      team: string;
      techGroup: string;
      ownerNames: string;
      participantNames?: string;
      stageCount: number;
      projectStatus: string;
      currentStageName: string;
      projectDueAt: string | null;
      currentStateLabel: string;
      recipientOpenIds: string[];
    }
  | {
      type: "project_comment_created";
      projectId: string;
      projectName: string;
      authorOpenId: string;
      authorName: string;
      content: string;
      createdAt: string;
      team: string;
      techGroup: string;
      ownerNames: string;
      currentStageName: string;
      recipientOpenIds: string[];
    }
  | {
      type: "project_updated";
      projectId: string;
      projectName: string;
      actorName: string;
      changes: string[];
      team: string;
      techGroup: string;
      oldTeam: string;
      oldTechGroup: string;
      ownerOpenIds: string[];
      oldOwnerOpenIds: string[];
      participantOpenIds?: string[];
      oldParticipantOpenIds?: string[];
      recipientOpenIds?: string[];
    }
  | {
      type: "project_stage_rollback";
      projectId: string;
      projectName: string;
      stageId: string;
      stageName: string;
      actorName: string;
      reason: string;
      team: string;
      techGroup: string;
      ownerOpenIds: string[];
      ownerNames: string;
      stageOwnerOpenIds: string[];
      recipientOpenIds?: string[];
    }
  | {
      type: "project_stage_extension_requested";
      requestId: string;
      projectId: string;
      projectName: string;
      stageId: string;
      stageName: string;
      requesterName: string;
      requesterOpenId: string;
      reason: string;
      durationDays: number;
      requestedIsBenign: boolean;
      oldDueAt: string | null;
      newDueAt: string;
      team: string;
      techGroup: string;
      recipientOpenIds?: string[];
    }
  | {
      type: "project_stage_batch_due_change_requested";
      requestId: string;
      projectId: string;
      projectName: string;
      stageId: string;
      stageName: string;
      requesterName: string;
      requesterOpenId: string;
      reason: string;
      durationDays: number;
      requestedIsBenign: boolean | null;
      oldDueAt: string | null;
      newDueAt: string;
      affectedStageNames: string[];
      team: string;
      techGroup: string;
      recipientOpenIds?: string[];
    }
  | {
      type: "project_stage_extension_approved" | "project_stage_extension_rejected";
      requestId: string;
      projectId: string;
      projectName: string;
      stageId: string;
      stageName: string;
      reviewerName: string;
      requesterOpenId: string;
      reason: string;
      comment: string;
      durationDays: number;
      finalIsBenign: boolean;
      oldDueAt?: string | null;
      newDueAt?: string | null;
      team: string;
      techGroup: string;
      ownerOpenIds: string[];
      stageOwnerOpenIds: string[];
      recipientOpenIds?: string[];
    }
  | {
      type:
        | "project_stage_batch_due_change_approved"
        | "project_stage_batch_due_change_rejected";
      requestId: string;
      projectId: string;
      projectName: string;
      stageId: string;
      stageName: string;
      reviewerName: string;
      requesterOpenId: string;
      reason: string;
      comment: string;
      durationDays: number;
      finalIsBenign: boolean;
      oldDueAt?: string | null;
      newDueAt?: string | null;
      affectedStageNames: string[];
      team: string;
      techGroup: string;
      ownerOpenIds: string[];
      stageOwnerOpenIds: string[];
      recipientOpenIds?: string[];
    }
  | {
      type: "project_stage_due_change_requested";
      requestId: string;
      projectId: string;
      projectName: string;
      stageId: string;
      stageName: string;
      requesterName: string;
      requesterOpenId: string;
      reason: string;
      oldDueAt: string | null;
      newDueAt: string;
      team: string;
      techGroup: string;
      ownerOpenIds: string[];
      recipientOpenIds?: string[];
    }
  | {
      type: "project_stage_due_change_approved" | "project_stage_due_change_rejected";
      requestId: string;
      projectId: string;
      projectName: string;
      stageId: string;
      stageName: string;
      reviewerName: string;
      requesterOpenId: string;
      reason: string;
      comment: string;
      oldDueAt: string | null;
      newDueAt: string | null;
      stageOwnerOpenId: string;
      recipientOpenIds?: string[];
    }
  | {
      type: "stage_pending_acceptance";
      projectId: string;
      projectName: string;
      stageName: string;
      team: string;
      techGroup: string;
      ownerOpenIds: string[];
      submitterOpenId: string;
      submitterName?: string;
      evidenceUrl: string;
      recipientOpenIds?: string[];
    }
  | {
      type: "stage_approved" | "stage_rejected";
      projectId: string;
      projectName: string;
      stageName: string;
      stageOwnerOpenId: string;
      reviewerName?: string;
      comment?: string;
      recipientOpenIds?: string[];
    }
  | {
      type: "project_stage_risk_synced";
      projectId: string;
      projectName: string;
      stageId: string;
      stageName: string;
      team: string;
      techGroup: string;
      ownerNames: string;
      stageOwnerName: string;
      actorName: string;
      riskNote: string;
      recipientOpenIds: string[];
    }
  | {
      type: "project_stage_risk_resolved";
      projectId: string;
      projectName: string;
      stageId: string;
      stageName: string;
      riskNote: string;
      resolveNote: string;
      resolverName: string;
      recipientOpenIds: string[];
    }
  | {
      type: "task_assigned";
      taskId: string;
      taskTitle: string;
      projectId: string;
      projectName: string;
      actorName?: string;
      team: string;
      techGroup: string;
      assigneeOpenIds: string[];
      recipientOpenIds: string[];
    } & TaskNotificationDetails
  | {
      type: "task_followed" | "task_unfollowed";
      taskId: string;
      taskTitle: string;
      projectId: string;
      projectName: string;
      actorName: string;
      stageName: string;
      assigneeNames: string;
      taskTechGroups: string[];
      team: string;
      techGroup: string;
      projectOwnerNames: string;
      taskStatus: TaskStatus;
      dueAt: string;
      currentStateLabel: string;
      recipientOpenIds: string[];
    }
  | {
      type: "task_updated";
      taskId: string;
      taskTitle: string;
      projectName: string;
      actorName: string;
      changes: string[];
      team: string;
      techGroup: string;
      oldTeam: string;
      oldTechGroup: string;
      assigneeOpenIds: string[];
      oldAssigneeOpenIds: string[];
      projectOwnerOpenIds: string[];
      recipientOpenIds?: string[];
    }
  | {
      type: "task_restarted";
      taskId: string;
      taskTitle: string;
      projectId: string;
      projectName: string;
      stageId: string | null;
      stageName: string;
      actorName: string;
      reason: string;
      fromStatus: TaskStatus;
      team: string;
      techGroup: string;
      assigneeOpenIds: string[];
      projectOwnerOpenIds: string[];
      recipientOpenIds?: string[];
    }
  | {
      type: "task_ddl_change_requested";
      requestId: string;
      taskId: string;
      taskTitle: string;
      projectName: string;
      requesterName: string;
      oldDueAt: string;
      newDueAt: string;
      reason: string;
      recipientOpenIds: string[];
    }
  | {
      type: "task_ddl_change_approved" | "task_ddl_change_rejected";
      requestId: string;
      taskId: string;
      taskTitle: string;
      projectName: string;
      reviewerName: string;
      requesterOpenId: string;
      oldDueAt: string;
      newDueAt: string;
      reason: string;
      comment: string;
      recipientOpenIds: string[];
    }
  | {
      type: "task_delete_requested";
      taskId: string;
      taskTitle: string;
      projectName: string;
      requesterName: string;
      reason: string;
      team: string;
      techGroup: string;
      projectOwnerOpenIds: string[];
      recipientOpenIds?: string[];
    }
  | {
      type: "task_deleted";
      taskId: string;
      taskTitle: string;
      projectId: string;
      projectName: string;
      stageId: string | null;
      stageName: string;
      actorName: string;
      reason: string;
      team: string;
      techGroup: string;
      assigneeOpenIds: string[];
      projectOwnerOpenIds: string[];
      recipientOpenIds?: string[];
    }
  | {
      type: "task_delete_rejected";
      taskId: string;
      taskTitle: string;
      projectName: string;
      reviewerName: string;
      reason: string;
      comment: string;
      requesterOpenId: string;
      assigneeOpenIds: string[];
      recipientOpenIds?: string[];
    }
  | {
      type: "task_creation_requested";
      requestId: string;
      projectId: string;
      projectName: string;
      taskTitle: string;
      requesterName: string;
      team: string;
      techGroup: string;
      projectOwnerOpenIds: string[];
      stageName?: string;
      assigneeNames?: string;
      taskTechGroups?: string[];
      dueAt?: string;
      recipientOpenIds?: string[];
    }
  | {
      type: "task_creation_approved";
      requestId: string;
      taskId: string;
      projectId: string;
      projectName: string;
      taskTitle: string;
      reviewerName: string;
      requesterOpenId: string;
      assigneeOpenIds: string[];
      team: string;
      techGroup: string;
      projectOwnerOpenIds: string[];
      recipientOpenIds?: string[];
    } & TaskNotificationDetails
  | {
      type: "task_creation_rejected";
      requestId: string;
      projectId: string;
      projectName: string;
      taskTitle: string;
      reviewerName: string;
      requesterOpenId: string;
      comment: string;
      recipientOpenIds: string[];
    }
  | {
      type: "task_bulk_imported" | "task_bulk_creation_requested";
      batchId: string;
      projectId: string;
      projectName: string;
      actorName: string;
      taskCount: number;
      tasks: Array<{
        title: string;
        stageName: string;
        assigneeNames: string;
        taskTechGroups: string[];
        dueAt: string;
      }>;
      team: string;
      techGroup: string;
      recipientOpenIds: string[];
    }
  | {
      type: "task_pending_acceptance";
      taskId: string;
      taskTitle: string;
      projectName: string;
      team: string;
      techGroup: string;
      feishuDocUrl: string;
      keyDataUrl: string;
      recipientOpenIds?: string[];
    }
  | {
      type: "task_approved";
      taskId: string;
      taskTitle: string;
      projectName: string;
      assigneeOpenIds: string[];
      recipientOpenIds?: string[];
    }
  | {
      type: "task_rejected";
      taskId: string;
      taskTitle: string;
      projectName: string;
      stageName?: string | null;
      assigneeNames?: string;
      taskTechGroups?: string[];
      reviewerName?: string;
      submitterName?: string;
      feishuDocUrl?: string;
      keyDataUrl?: string;
      assigneeOpenIds: string[];
      comment?: string;
      recipientOpenIds?: string[];
    }
  | {
      type: "task_overdue";
      taskId: string;
      taskTitle: string;
      projectName: string;
      team: string;
      techGroup: string;
      assigneeOpenIds: string[];
      recipientOpenIds: string[];
    }
  | {
      type: "task_risk_synced";
      taskId: string;
      taskTitle: string;
      projectName: string;
      team: string;
      techGroup: string;
      assigneeOpenIds: string[];
      projectOwnerOpenIds: string[];
      recipientOpenIds?: string[];
      riskNote: string;
    }
  | {
      type: "task_risk_resolved";
      taskId: string;
      taskTitle: string;
      projectName: string;
      riskNote: string;
      resolveNote: string;
      resolverName: string;
      recipientOpenIds: string[];
    }
  | {
      type: "weekly_report_reminder";
      taskId: string;
      taskTitle: string;
      assigneeOpenIds: string[];
      recipientOpenIds: string[];
    }
  | {
      type: "progress_reminder";
      targetType: "PROJECT" | "TASK";
      targetId: string;
      projectId?: string;
      taskId?: string;
      projectName: string;
      taskTitle?: string;
      stageName?: string;
      title: string;
      reason: string;
      actorName?: string;
      message?: string;
      recipientOpenIds: string[];
      linkPath: string;
    }
  | {
      type: "progress_daily_summary";
      summaryDate: string;
      generatedAt: string;
      recipientOpenIds: string[];
      recipientName?: string;
      overview: {
        taskCount: number;
        projectCount: number;
        ddlCount: number;
        overdueTaskCount: number;
        pendingAcceptanceTaskCount: number;
        riskTaskCount: number;
        overdueDdlCount: number;
      };
      tasks: Array<{
        taskId: string;
        title: string;
        projectName: string;
        stageName: string;
        statusLabel: string;
        assigneeNames: string;
        taskTechGroups: string[];
        urgencyLabel: string;
        importanceLabel: string;
        dueAt: string;
        dueLabel: string;
        isOverdue: boolean;
        riskNote: string;
        needsWeeklyReport: boolean;
        linkPath: string;
      }>;
      taskTotalCount: number;
      projects: Array<{
        projectId: string;
        name: string;
        statusLabel: string;
        team: string;
        techGroup: string;
        ownerNames: string;
        currentStageName: string;
        currentStageStatusLabel: string;
        projectDueAt: string | null;
        projectDueLabel: string;
        activeTaskCount: number;
        overdueTaskCount: number;
        pendingAcceptanceTaskCount: number;
        riskCount: number;
        linkPath: string;
      }>;
      projectTotalCount: number;
      ddlItems: Array<{
        kind: "PROJECT" | "STAGE" | "TASK";
        id: string;
        title: string;
        projectName: string;
        stageName?: string;
        dueAt: string;
        dueLabel: string;
        isOverdue: boolean;
        linkPath: string;
      }>;
      ddlTotalCount: number;
      linkPath: string;
      approvalsLinkPath: string;
    };

type CardAction = {
  text: string;
  url: string;
  type?: "default" | "primary" | "danger";
};

function buildCard(
  title: string,
  content: string,
  url: string,
  template: "blue" | "red" | "orange" | "green" = "blue",
  actions?: CardAction[],
) {
  const resolvedActions = actions ?? [
    { text: "打开系统", url, type: "primary" as const },
  ];
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title }, template },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content },
      },
      {
        tag: "action",
        actions: resolvedActions.map((action) => ({
          tag: "button",
          text: { tag: "plain_text", content: action.text },
          url: action.url,
          type: action.type ?? "default",
        })),
      },
    ],
  };
}

async function sendDirectCard(
  openId: string,
  card: ReturnType<typeof buildCard>,
) {
  if (!(await isFeishuDirectMessageAllowed(openId))) {
    logger.info("feishu.progress.direct_message.skipped_by_allowlist", {
      module: "feishu",
      action: "sendProgressDirectCard",
      recipientOpenId: openId,
      result: "skipped",
    });
    return;
  }

  const botKind = progressBotKindStorage.getStore() ?? "notification";
  const target = await resolveDirectMessageTarget(openId, botKind);
  try {
    await postDirectCard(target, card);
    logger.info("feishu.progress.direct_message.sent", {
      module: "feishu",
      action: "sendProgressDirectCard",
      recipientOpenId: openId,
      botKind: target.botKind,
      receiveIdType: target.receiveIdType,
      result: "success",
    });
  } catch (error) {
    if (!shouldFallbackApprovalBotUnavailable(target.botKind, error)) {
      logger.error("feishu.progress.direct_message.failed", {
        module: "feishu",
        action: "sendProgressDirectCard",
        recipientOpenId: openId,
        botKind: target.botKind,
        receiveIdType: target.receiveIdType,
        error,
      });
      throw error;
    }
    logger.warn("feishu.progress.approval_bot_fallback", {
      module: "feishu",
      action: "sendProgressDirectCard",
      recipientOpenId: openId,
      botKind: target.botKind,
      receiveIdType: target.receiveIdType,
      error,
    });
    await postDirectCard(
      await resolveDirectMessageTarget(openId, "notification"),
      card,
    );
    logger.info("feishu.progress.direct_message.sent", {
      module: "feishu",
      action: "sendProgressDirectCard",
      recipientOpenId: openId,
      botKind: "notification",
      result: "success",
      fallback: true,
    });
  }
}

async function postDirectCard(
  target: FeishuDirectMessageTarget,
  card: ReturnType<typeof buildCard>,
) {
  const token = await getFeishuTenantAccessTokenByBotKind(target.botKind);
  const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
  url.searchParams.set("receive_id_type", target.receiveIdType);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: target.receiveId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  });

  const data = (await res.json()) as { code: number; msg?: string };
  if (data.code !== 0) {
    throw new Error(
      `飞书私信失败(${target.receiveIdType}:${target.receiveId}): ${data.msg}`,
    );
  }
}

async function notifyRoles(
  roles: UserRoleType[],
  scope: { team: string; techGroup: string },
  card: ReturnType<typeof buildCard>,
) {
  const openIdSet = new Set<string>();
  for (const role of roles) {
    const ids = await getOpenIdsByRole(role, scope);
    ids.forEach((id) => openIdSet.add(id));
  }
  await sendCardToOpenIds([...openIdSet], card);
}

async function notifyRolesExcept(
  roles: UserRoleType[],
  scope: { team: string; techGroup: string },
  excludedOpenIds: string[],
  card: ReturnType<typeof buildCard>,
) {
  const excluded = new Set(excludedOpenIds.filter(Boolean));
  const openIdSet = new Set<string>();
  for (const role of roles) {
    const ids = await getOpenIdsByRole(role, scope);
    ids.forEach((id) => {
      if (!excluded.has(id)) openIdSet.add(id);
    });
  }
  await sendCardToOpenIds([...openIdSet], card);
}

async function notifyOpenIdsAndRoles(
  openIds: string[],
  roles: UserRoleType[],
  scope: { team: string; techGroup: string },
  card: ReturnType<typeof buildCard>,
) {
  const openIdSet = new Set(openIds.filter(Boolean));
  for (const role of roles) {
    const ids = await getOpenIdsByRole(role, scope);
    ids.forEach((id) => openIdSet.add(id));
  }
  await sendCardToOpenIds([...openIdSet], card);
}

async function notifyOpenIdsAndRoleScopes(
  openIds: string[],
  roles: UserRoleType[],
  scopes: Array<{ team: string; techGroup: string }>,
  card: ReturnType<typeof buildCard>,
) {
  const openIdSet = new Set(openIds.filter(Boolean));
  for (const role of roles) {
    for (const scope of scopes) {
      const ids = await getOpenIdsByRole(role, scope);
      ids.forEach((id) => openIdSet.add(id));
    }
  }
  await sendCardToOpenIds([...openIdSet], card);
}

async function notifyOpenIds(
  openIds: string[],
  card: ReturnType<typeof buildCard>,
) {
  const openIdSet = new Set(openIds.filter(Boolean));
  await sendCardToOpenIds([...openIdSet], card);
}

async function sendCardToOpenIds(
  openIds: string[],
  card: ReturnType<typeof buildCard>,
) {
  const recipients = [...new Set(openIds.filter(Boolean))];
  if (recipients.length === 0) return;

  logger.info("feishu.progress.direct_message.batch.start", {
    module: "feishu",
    action: "sendProgressCards",
    recipientCount: recipients.length,
    botKind: progressBotKindStorage.getStore() ?? "notification",
  });
  const results = await Promise.allSettled(
    recipients.map((id) => sendDirectCard(id, card)),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    const reason = failures[0]?.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new Error(
      `飞书通知发送失败：${failures.length}/${results.length} 个收件人失败；${message}`,
    );
  }
  logger.info("feishu.progress.direct_message.batch.completed", {
    module: "feishu",
    action: "sendProgressCards",
    recipientCount: recipients.length,
    result: "success",
  });
}

export async function sendProgressNotification(
  payload: ProgressNotifyPayload,
  context?: NotificationContext,
  botKind: FeishuBotKind = resolveProgressBotKind(payload.type),
) {
  return progressBotKindStorage.run(botKind, async () => {
  const appOrigin = context?.appOrigin;
  if (
    EXPLICIT_RECIPIENT_REQUIRED_TYPES.has(payload.type) &&
    getExplicitRecipientOpenIds(payload).length === 0
  ) {
    logger.warn("feishu.progress.notification.missing_recipients", {
      module: "feishu",
      action: "sendProgressNotification",
      type: payload.type,
      botKind,
      result: "skipped",
    });
    return;
  }

  switch (payload.type) {
    case "project_establishment_requested": {
      const participantLine = `\n**参与人**：${payload.participantNames || "无"}`;
      const card = buildCard(
        "项目立项待审批",
        `**项目**：${payload.projectName}\n**申请人**：${payload.requesterName}\n**负责人**：${payload.ownerNames || "未设置"}${participantLine}\n**车组/技术组**：${formatScope(payload.team, payload.techGroup)}\n**阶段数量**：${payload.stageCount} 个`,
        buildAppUrl(routes.progress.project(payload.projectId), appOrigin),
        "orange",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "project_establishment_approved": {
      const participantLine = `\n**参与人**：${payload.participantNames || "无"}`;
      const commentLine = payload.comment
        ? `\n**审核意见**：${payload.comment}`
        : "";
      const card = buildCard(
        "项目立项已通过",
        `**项目**：${payload.projectName}\n**申请人**：${payload.requesterName}\n**审核人**：${payload.reviewerName}\n**负责人**：${payload.ownerNames || "未设置"}${participantLine}\n**车组/技术组**：${formatScope(payload.team, payload.techGroup)}\n**阶段数量**：${payload.stageCount} 个\n**当前状态**：未开始，可启动项目${commentLine}`,
        buildAppUrl(routes.progress.project(payload.projectId), appOrigin),
        "green",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "project_establishment_rejected": {
      const card = buildCard(
        "项目立项已驳回",
        `**项目**：${payload.projectName}\n**申请人**：${payload.requesterName}\n**审核人**：${payload.reviewerName}\n**车组/技术组**：${formatScope(payload.team, payload.techGroup)}\n**审核意见**：${payload.comment}`,
        buildAppUrl(routes.progress.project(payload.projectId), appOrigin),
        "red",
      );
      await notifyOpenIds(payload.recipientOpenIds ?? [payload.requesterOpenId], card);
      break;
    }
    case "project_started":
    case "project_completed":
    case "project_canceled": {
      const title =
        payload.type === "project_started"
          ? "项目已启动"
          : payload.type === "project_completed"
            ? "项目已完成"
            : "项目已取消";
      const template = payload.type === "project_canceled" ? "red" : "green";
      const canceledTaskLine =
        payload.type === "project_canceled"
          ? `\n**同步取消任务**：${payload.canceledTaskCount ?? 0} 个`
          : "";
      const participantLine = `\n**参与人**：${payload.participantNames || "无"}`;
      const card = buildCard(
        title,
        `**项目**：${payload.projectName}\n**负责人**：${payload.ownerNames}${participantLine}\n**车组/技术组**：${formatScope(payload.team, payload.techGroup)}${canceledTaskLine}`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
        template,
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoles(
          [
            ...payload.ownerOpenIds,
            ...(payload.participantOpenIds ?? []),
          ],
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          card,
        );
      }
      break;
    }
    case "project_followed":
    case "project_unfollowed": {
      const followed = payload.type === "project_followed";
      const participantLine = `\n**参与人**：${payload.participantNames || "无"}`;
      const card = buildCard(
        followed ? "已关注项目" : "已取消关注项目",
        `**项目**：${payload.projectName}\n**操作人**：${payload.actorName}\n**项目状态**：${formatProjectStatus(payload.projectStatus)}\n**当前阶段**：${payload.currentStageName}\n**项目 DDL**：${formatNotificationDateTime(payload.projectDueAt)}\n**负责人**：${payload.ownerNames || "未设置"}${participantLine}\n**车组/技术组**：${formatScope(payload.team, payload.techGroup)}\n**阶段数量**：${payload.stageCount} 个\n**当前通知状态**：${payload.currentStateLabel}`,
        buildAppUrl(routes.progress.project(payload.projectId), appOrigin),
        followed ? "green" : "orange",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "project_comment_created": {
      const card = buildCard(
        "项目有新评论",
        `**项目**：${payload.projectName}\n**评论人**：${payload.authorName}\n**评论时间**：${formatNotificationDateTime(payload.createdAt)}\n**当前阶段**：${payload.currentStageName}\n**负责人**：${payload.ownerNames || "未设置"}\n**车组/技术组**：${formatScope(payload.team, payload.techGroup)}\n**评论内容**：\n${payload.content}`,
        buildAppUrl(routes.progress.project(payload.projectId), appOrigin),
        "blue",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "project_updated": {
      const card = buildCard(
        "项目信息已更新",
        `**项目**：${payload.projectName}\n**修改人**：${payload.actorName}\n${formatChangeList(payload.changes)}`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoleScopes(
          [
            ...payload.ownerOpenIds,
            ...payload.oldOwnerOpenIds,
            ...(payload.participantOpenIds ?? []),
            ...(payload.oldParticipantOpenIds ?? []),
          ],
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          [
            { team: payload.team, techGroup: payload.techGroup },
            { team: payload.oldTeam, techGroup: payload.oldTechGroup },
          ],
          card,
        );
      }
      break;
    }
    case "project_stage_rollback": {
      const card = buildCard(
        "项目流程已回退",
        `**项目**：${payload.projectName}\n**回退阶段**：${payload.stageName}\n**操作人**：${payload.actorName}\n**原因**：${payload.reason}`,
        buildAppUrl(
          routes.progress.projectStage(payload.projectId, payload.stageId),
          appOrigin,
        ),
        "orange",
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoles(
          [...payload.ownerOpenIds, ...payload.stageOwnerOpenIds],
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          card,
        );
      }
      break;
    }
    case "project_stage_extension_requested": {
      const card = buildCard(
        "阶段延期申请待审批",
        `**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**申请人**：${payload.requesterName}\n**延期时长**：${payload.durationDays} 天\n**是否良性**：${payload.requestedIsBenign ? "是" : "否"}\n**当前 DDL**：${formatNotificationDateTime(payload.oldDueAt)}\n**延期后 DDL**：${formatNotificationDateTime(payload.newDueAt)}\n**原因**：${payload.reason}`,
        buildAppUrl(
          routes.progress.projectStage(payload.projectId, payload.stageId),
          appOrigin,
        ),
        "orange",
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(
          payload.recipientOpenIds.filter((openId) => openId !== payload.requesterOpenId),
          card,
        );
      } else {
        await notifyRolesExcept(
          ["PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          [payload.requesterOpenId],
          card,
        );
      }
      break;
    }
    case "project_stage_batch_due_change_requested": {
      const adjustment = formatBatchDueChangeAdjustment(payload.durationDays);
      const benignLine =
        payload.durationDays > 0
          ? `\n**是否良性**：${payload.requestedIsBenign ? "是" : "否"}`
          : "";
      const card = buildCard(
        `批量${adjustment.directionLabel}申请待审批`,
        `**项目**：${payload.projectName}\n**起始阶段**：${payload.stageName}\n**影响范围**：${formatAffectedStageNames(payload.affectedStageNames)}\n**申请人**：${payload.requesterName}\n**调整方向**：${adjustment.directionLabel}\n**调整时长**：${adjustment.days} 天${benignLine}\n**当前 DDL**：${formatNotificationDateTime(payload.oldDueAt)}\n**调整后 DDL**：${formatNotificationDateTime(payload.newDueAt)}\n**原因**：${payload.reason}`,
        buildAppUrl(
          routes.progress.projectStage(payload.projectId, payload.stageId),
          appOrigin,
        ),
        "orange",
      );
      await notifyOpenIds(
        (payload.recipientOpenIds ?? []).filter(
          (openId) => openId !== payload.requesterOpenId,
        ),
        card,
      );
      break;
    }
    case "project_stage_extension_approved":
    case "project_stage_extension_rejected": {
      const pass = payload.type === "project_stage_extension_approved";
      const card = buildCard(
        pass ? "阶段延期申请已通过" : "阶段延期申请已驳回",
        `**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**审核人**：${payload.reviewerName}\n**延期时长**：${payload.durationDays} 天\n**最终良性**：${payload.finalIsBenign ? "是" : "否"}\n**原 DDL**：${formatNotificationDateTime(payload.oldDueAt ?? null)}\n**新 DDL**：${formatNotificationDateTime(payload.newDueAt ?? null)}\n**申请原因**：${payload.reason}\n**审批意见**：${payload.comment}`,
        buildAppUrl(
          routes.progress.projectStage(payload.projectId, payload.stageId),
          appOrigin,
        ),
        pass ? "green" : "red",
      );
      await notifyOpenIds(
        payload.recipientOpenIds ?? [
          payload.requesterOpenId,
          ...payload.ownerOpenIds,
          ...payload.stageOwnerOpenIds,
        ],
        card,
      );
      break;
    }
    case "project_stage_batch_due_change_approved":
    case "project_stage_batch_due_change_rejected": {
      const pass = payload.type === "project_stage_batch_due_change_approved";
      const adjustment = formatBatchDueChangeAdjustment(payload.durationDays);
      const benignLine =
        payload.durationDays > 0
          ? `\n**最终良性**：${payload.finalIsBenign ? "是" : "否"}`
          : "";
      const card = buildCard(
        `批量${adjustment.directionLabel}${pass ? "已通过" : "已驳回"}`,
        `**项目**：${payload.projectName}\n**起始阶段**：${payload.stageName}\n**影响范围**：${formatAffectedStageNames(payload.affectedStageNames)}\n**审核人**：${payload.reviewerName}\n**调整方向**：${adjustment.directionLabel}\n**调整时长**：${adjustment.days} 天${benignLine}\n**原 DDL**：${formatNotificationDateTime(payload.oldDueAt ?? null)}\n**新 DDL**：${formatNotificationDateTime(payload.newDueAt ?? null)}\n**申请原因**：${payload.reason}\n**审批意见**：${payload.comment}`,
        buildAppUrl(
          routes.progress.projectStage(payload.projectId, payload.stageId),
          appOrigin,
        ),
        pass ? "green" : "red",
      );
      await notifyOpenIds(
        payload.recipientOpenIds ?? [
          payload.requesterOpenId,
          ...payload.ownerOpenIds,
          ...payload.stageOwnerOpenIds,
        ],
        card,
      );
      break;
    }
    case "project_stage_due_change_requested": {
      const card = buildCard(
        "阶段 DDL 修改申请待审批",
        `**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**申请人**：${payload.requesterName}\n**当前 DDL**：${formatNotificationDateTime(payload.oldDueAt)}\n**新 DDL**：${formatNotificationDateTime(payload.newDueAt)}\n**原因**：${payload.reason}`,
        buildAppUrl(
          routes.progress.projectStage(payload.projectId, payload.stageId),
          appOrigin,
        ),
        "orange",
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(
          payload.recipientOpenIds.filter((openId) => openId !== payload.requesterOpenId),
          card,
        );
      } else if (payload.ownerOpenIds.includes(payload.requesterOpenId)) {
        await notifyRolesExcept(
          ["PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          [payload.requesterOpenId],
          card,
        );
      } else {
        await notifyOpenIds(payload.ownerOpenIds, card);
      }
      break;
    }
    case "project_stage_due_change_approved":
    case "project_stage_due_change_rejected": {
      const pass = payload.type === "project_stage_due_change_approved";
      const card = buildCard(
        pass ? "阶段 DDL 修改已通过" : "阶段 DDL 修改已驳回",
        `**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**审核人**：${payload.reviewerName}\n**原 DDL**：${formatNotificationDateTime(payload.oldDueAt)}\n**新 DDL**：${formatNotificationDateTime(payload.newDueAt)}\n**申请原因**：${payload.reason}\n**审批意见**：${payload.comment}`,
        buildAppUrl(
          routes.progress.projectStage(payload.projectId, payload.stageId),
          appOrigin,
        ),
        pass ? "green" : "red",
      );
      await notifyOpenIds(
        payload.recipientOpenIds ?? [payload.requesterOpenId, payload.stageOwnerOpenId],
        card,
      );
      break;
    }
    case "stage_pending_acceptance": {
      const card = buildCard(
        "项目阶段待审批",
        `**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**提交人**：${payload.submitterName ?? payload.submitterOpenId}\n**归档链接**：[打开材料](${payload.evidenceUrl})`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
        "orange",
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoles(
          [...payload.ownerOpenIds, payload.submitterOpenId],
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          card,
        );
      }
      break;
    }
    case "stage_approved":
    case "stage_rejected": {
      const pass = payload.type === "stage_approved";
      const card = buildCard(
        pass ? "项目阶段审批通过" : "项目阶段审批驳回",
        `**项目**：${payload.projectName}\n**阶段**：${payload.stageName}${payload.reviewerName ? `\n**审核人**：${payload.reviewerName}` : ""}${payload.comment ? `\n**审批意见**：${payload.comment}` : ""}`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
        pass ? "green" : "red",
      );
      await notifyOpenIds(payload.recipientOpenIds ?? [payload.stageOwnerOpenId], card);
      break;
    }
    case "project_stage_risk_synced": {
      const card = buildCard(
        "项目阶段风险同步",
        `**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**同步人**：${payload.actorName}\n**项目负责人**：${payload.ownerNames || "未设置"}\n**阶段负责人**：${payload.stageOwnerName || "未设置"}\n**风险**：${payload.riskNote}`,
        buildAppUrl(
          routes.progress.projectStage(payload.projectId, payload.stageId),
          appOrigin,
        ),
        "red",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "project_stage_risk_resolved": {
      const card = buildCard(
        "项目阶段风险已取消",
        `**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**取消人**：${payload.resolverName}\n**原风险**：${payload.riskNote}\n**取消说明**：${payload.resolveNote}`,
        buildAppUrl(
          routes.progress.projectStage(payload.projectId, payload.stageId),
          appOrigin,
        ),
        "green",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "task_assigned": {
      const card = buildCard(
        "新任务指派",
        [
          `**任务**：${payload.taskTitle}`,
          `**项目**：${payload.projectName}`,
          payload.actorName ? `**创建人**：${payload.actorName}` : null,
          ...formatTaskNotificationDetailLines(payload),
        ]
          .filter(Boolean)
          .join("\n"),
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
      );
      await notifyOpenIds(payload.recipientOpenIds ?? payload.assigneeOpenIds, card);
      break;
    }
    case "task_followed":
    case "task_unfollowed": {
      const followed = payload.type === "task_followed";
      const card = buildCard(
        followed ? "已关注任务" : "已取消关注任务",
        [
          `**任务**：${payload.taskTitle}`,
          `**项目**：${payload.projectName}`,
          `**操作人**：${payload.actorName}`,
          `**任务状态**：${taskStatusLabels[payload.taskStatus]}`,
          `**车组/技术组**：${formatScope(payload.team, payload.techGroup)}`,
          `**项目负责人**：${payload.projectOwnerNames || "未设置"}`,
          `**阶段**：${payload.stageName}`,
          `**负责人**：${payload.assigneeNames || "未设置"}`,
          payload.taskTechGroups.length
            ? `**任务技术组**：${payload.taskTechGroups.join("、")}`
            : null,
          `**DDL**：${formatDateTime(payload.dueAt)}`,
          `**当前通知状态**：${payload.currentStateLabel}`,
        ]
          .filter(Boolean)
          .join("\n"),
        buildAppUrl(routes.progress.task(payload.taskId), appOrigin),
        followed ? "green" : "orange",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "task_updated": {
      const card = buildCard(
        "任务信息已更新",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**修改人**：${payload.actorName}\n${formatChangeList(payload.changes)}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoleScopes(
          [
            ...payload.assigneeOpenIds,
            ...payload.oldAssigneeOpenIds,
            ...payload.projectOwnerOpenIds,
          ],
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          [
            { team: payload.team, techGroup: payload.techGroup },
            { team: payload.oldTeam, techGroup: payload.oldTechGroup },
          ],
          card,
        );
      }
      break;
    }
    case "task_restarted": {
      const card = buildCard(
        "任务已重启",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**操作人**：${payload.actorName}\n**状态**：${taskStatusLabels[payload.fromStatus]} -> ${taskStatusLabels.IN_PROGRESS}\n**原因**：${payload.reason}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "orange",
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoles(
          [...payload.assigneeOpenIds, ...payload.projectOwnerOpenIds],
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          card,
        );
      }
      break;
    }
    case "task_ddl_change_requested": {
      const card = buildCard(
        "任务 DDL 修改申请待审核",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**申请人**：${payload.requesterName}\n**当前 DDL**：${formatDateTime(payload.oldDueAt)}\n**申请 DDL**：${formatDateTime(payload.newDueAt)}\n**原因**：${payload.reason}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "orange",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "task_ddl_change_approved":
    case "task_ddl_change_rejected": {
      const approved = payload.type === "task_ddl_change_approved";
      const card = buildCard(
        approved ? "任务 DDL 修改已通过" : "任务 DDL 修改已驳回",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**审核人**：${payload.reviewerName}\n**原 DDL**：${formatDateTime(payload.oldDueAt)}\n**申请 DDL**：${formatDateTime(payload.newDueAt)}\n**申请原因**：${payload.reason}${payload.comment ? `\n**审核意见**：${payload.comment}` : ""}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        approved ? "green" : "red",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "task_delete_requested": {
      const card = buildCard(
        "任务删除申请待审核",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**申请人**：${payload.requesterName}\n**原因**：${payload.reason}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "orange",
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoles(
          payload.projectOwnerOpenIds,
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          card,
        );
      }
      break;
    }
    case "task_deleted": {
      const card = buildCard(
        "任务已删除",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**操作人**：${payload.actorName}\n**原因**：${payload.reason}`,
        buildAppUrl(
          payload.stageId
            ? routes.progress.projectStage(payload.projectId, payload.stageId)
            : routes.progress.project(payload.projectId),
          appOrigin,
        ),
        "red",
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoles(
          [...payload.assigneeOpenIds, ...payload.projectOwnerOpenIds],
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          card,
        );
      }
      break;
    }
    case "task_delete_rejected": {
      const card = buildCard(
        "任务删除申请已驳回",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**审核人**：${payload.reviewerName}\n**申请原因**：${payload.reason}\n**审核意见**：${payload.comment}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "red",
      );
      await notifyOpenIds(
        payload.recipientOpenIds ?? [
          payload.requesterOpenId,
          ...payload.assigneeOpenIds,
        ],
        card,
      );
      break;
    }
    case "task_creation_requested": {
      const card = buildCard(
        "新任务申请待审核",
        [
          `**项目**：${payload.projectName}`,
          `**任务**：${payload.taskTitle}`,
          payload.stageName ? `**阶段**：${payload.stageName}` : null,
          payload.taskTechGroups?.length
            ? `**任务技术组**：${payload.taskTechGroups.join("、")}`
            : null,
          payload.assigneeNames ? `**负责人**：${payload.assigneeNames}` : null,
          payload.dueAt ? `**DDL**：${formatDateTime(payload.dueAt)}` : null,
          `**申请人**：${payload.requesterName}`,
        ]
          .filter(Boolean)
          .join("\n"),
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
        "orange",
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoles(
          payload.projectOwnerOpenIds,
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          card,
        );
      }
      break;
    }
    case "task_creation_approved": {
      const card = buildCard(
        "任务申请已通过",
        [
          `**项目**：${payload.projectName}`,
          `**任务**：${payload.taskTitle}`,
          `**审核人**：${payload.reviewerName}`,
          ...formatTaskNotificationDetailLines(payload),
        ]
          .filter(Boolean)
          .join("\n"),
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "green",
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoles(
          [
            payload.requesterOpenId,
            ...payload.assigneeOpenIds,
            ...payload.projectOwnerOpenIds,
          ],
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          card,
        );
      }
      break;
    }
    case "task_creation_rejected": {
      const card = buildCard(
        "任务申请已驳回",
        `**项目**：${payload.projectName}\n**任务**：${payload.taskTitle}\n**审核人**：${payload.reviewerName}\n**审核意见**：${payload.comment}`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
        "red",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "task_bulk_imported":
    case "task_bulk_creation_requested": {
      const isRequest = payload.type === "task_bulk_creation_requested";
      const taskLines = formatBulkTaskLines(payload.tasks);
      const card = buildCard(
        isRequest ? "批量任务申请待审核" : "批量任务已导入",
        [
          `**项目**：${payload.projectName}`,
          `**${isRequest ? "申请人" : "导入人"}**：${payload.actorName}`,
          `**任务数量**：${payload.taskCount} 条`,
          taskLines,
        ]
          .filter(Boolean)
          .join("\n"),
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
        isRequest ? "orange" : "blue",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "task_pending_acceptance": {
      const card = buildCard(
        "任务待验收",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**交付文档**：[打开文档](${payload.feishuDocUrl})\n**关键数据**：[打开材料](${payload.keyDataUrl})\n请先阅读材料后再在系统中审批。`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "orange",
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyRoles(
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          card,
        );
      }
      break;
    }
    case "task_risk_synced": {
      const card = buildCard(
        "任务风险同步",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**风险**：${payload.riskNote}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "red",
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoles(
          [...payload.assigneeOpenIds, ...payload.projectOwnerOpenIds],
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          card,
        );
      }
      break;
    }
    case "task_risk_resolved": {
      const card = buildCard(
        "任务风险已解除",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**解除人**：${payload.resolverName}\n**原风险**：${payload.riskNote}\n**解除说明**：${payload.resolveNote}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "green",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "task_approved": {
      const card = buildCard(
        "任务验收通过",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "green",
      );
      await notifyOpenIds(payload.recipientOpenIds ?? payload.assigneeOpenIds, card);
      break;
    }
    case "task_rejected": {
      const content = [
        `**任务**：${payload.taskTitle}`,
        `**项目**：${payload.projectName}`,
        payload.stageName !== undefined
          ? `**阶段**：${payload.stageName || "无阶段"}`
          : null,
        payload.assigneeNames ? `**负责人**：${payload.assigneeNames}` : null,
        payload.taskTechGroups
          ? `**任务技术组**：${
              payload.taskTechGroups.length > 0
                ? payload.taskTechGroups.join("、")
                : "通用"
            }`
          : null,
        payload.submitterName ? `**提交人**：${payload.submitterName}` : null,
        payload.reviewerName ? `**审核人**：${payload.reviewerName}` : null,
        payload.feishuDocUrl
          ? `**飞书文档**：${compactCardText(payload.feishuDocUrl, 140)}`
          : null,
        payload.keyDataUrl
          ? `**关键数据**：${compactCardText(payload.keyDataUrl, 140)}`
          : null,
        payload.comment ? `**驳回理由**：${payload.comment}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      const card = buildCard(
        "任务验收驳回",
        content,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "red",
      );
      await notifyOpenIds(payload.recipientOpenIds ?? payload.assigneeOpenIds, card);
      break;
    }
    case "task_overdue": {
      const card = buildCard(
        "任务逾期警报",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n请负责人尽快推进，组长/项管请关注。`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "red",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "weekly_report_reminder": {
      const card = buildCard(
        "周报填写提醒",
        `**任务**：${payload.taskTitle}\n请在系统中提交本周进度周报。`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "orange",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "progress_reminder": {
      const lines = [
        `**项目**：${payload.projectName}`,
        payload.taskTitle ? `**任务**：${payload.taskTitle}` : null,
        payload.stageName ? `**阶段**：${payload.stageName}` : null,
        payload.actorName ? `**发起人**：${payload.actorName}` : null,
        `**提醒原因**：\n${payload.reason}`,
        payload.message ? `**补充说明**：${payload.message}` : null,
      ].filter(Boolean);
      const card = buildCard(
        payload.title,
        lines.join("\n"),
        buildAppUrl(payload.linkPath, appOrigin),
        "orange",
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
    case "progress_daily_summary": {
      const progressUrl = buildAppUrl(payload.linkPath, appOrigin);
      const approvalsUrl = buildAppUrl(payload.approvalsLinkPath, appOrigin);
      const card = buildCard(
        `每日进度摘要 · ${payload.summaryDate}`,
        formatDailySummaryCard(payload, appOrigin),
        progressUrl,
        payload.overview.overdueTaskCount > 0 || payload.overview.overdueDdlCount > 0
          ? "orange"
          : "blue",
        [
          { text: "打开进度首页", url: progressUrl, type: "primary" },
          { text: "查看审批看板", url: approvalsUrl },
        ],
      );
      await notifyOpenIds(payload.recipientOpenIds, card);
      break;
    }
  }
  });
}

function getExplicitRecipientOpenIds(payload: ProgressNotifyPayload): string[] {
  if (!("recipientOpenIds" in payload)) return [];
  const recipientOpenIds = payload.recipientOpenIds;
  return Array.isArray(recipientOpenIds) ? recipientOpenIds.filter(Boolean) : [];
}

export async function sendProgressNotificationToOpenId(
  payload: ProgressNotifyPayload,
  openId: string,
  context?: NotificationContext,
  botKind: FeishuBotKind = resolveProgressBotKind(payload.type),
) {
  return sendProgressNotification(
    { ...payload, recipientOpenIds: [openId] } as ProgressNotifyPayload,
    context,
    botKind,
  );
}

function formatScope(team: string, techGroup: string): string {
  return `${team || "未指定"} / ${techGroup || "未指定"}`;
}

function formatProjectStatus(status: string): string {
  return projectStatusLabels[status as keyof typeof projectStatusLabels] ?? status;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN");
}

function formatChangeList(changes: string[]): string {
  if (changes.length === 0) return "**变更**：无字段变化";
  return `**变更**：\n${changes.map((change) => `- ${change}`).join("\n")}`;
}

function formatDailySummaryCard(
  payload: Extract<ProgressNotifyPayload, { type: "progress_daily_summary" }>,
  appOrigin?: string | null,
): string {
  const overview = [
    `任务 ${payload.overview.taskCount} 个`,
    `项目 ${payload.overview.projectCount} 个`,
    `DDL ${payload.overview.ddlCount} 个`,
    payload.overview.overdueTaskCount > 0
      ? `逾期任务 ${payload.overview.overdueTaskCount} 个`
      : null,
    payload.overview.pendingAcceptanceTaskCount > 0
      ? `待验收 ${payload.overview.pendingAcceptanceTaskCount} 个`
      : null,
    payload.overview.riskTaskCount > 0
      ? `风险任务 ${payload.overview.riskTaskCount} 个`
      : null,
  ].filter(Boolean);

  return [
    payload.recipientName ? `**收件人**：${payload.recipientName}` : null,
    `**生成时间**：${formatNotificationDateTime(payload.generatedAt)}`,
    `**今日概览**：${overview.join(" / ") || "暂无待跟进事项"}`,
    formatDailySummaryTaskSection(payload, appOrigin),
    formatDailySummaryProjectSection(payload, appOrigin),
    formatDailySummaryDdlSection(payload, appOrigin),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatDailySummaryTaskSection(
  payload: Extract<ProgressNotifyPayload, { type: "progress_daily_summary" }>,
  appOrigin?: string | null,
): string {
  if (payload.tasks.length === 0) return "**任务列表**：暂无需要跟进的任务";
  const lines = payload.tasks.map((task, index) => {
    const groups =
      task.taskTechGroups.length > 0 ? task.taskTechGroups.join("、") : "通用";
    const risk = task.riskNote ? `｜风险：${compactCardText(task.riskNote, 60)}` : "";
    const weekly = task.needsWeeklyReport ? "｜周报：需要" : "";
    return `${index + 1}. ${cardLink(task.title, task.linkPath, appOrigin)}｜${task.projectName} / ${task.stageName}｜${task.statusLabel}｜DDL：${formatNotificationDateTime(task.dueAt)}（${task.dueLabel}）｜紧急/重要：${task.urgencyLabel}/${task.importanceLabel}｜负责人：${task.assigneeNames || "未设置"}｜技术组：${groups}${weekly}${risk}`;
  });
  appendMoreLine(lines, payload.taskTotalCount, payload.tasks.length);
  return `**任务列表**：\n${lines.join("\n")}`;
}

function formatDailySummaryProjectSection(
  payload: Extract<ProgressNotifyPayload, { type: "progress_daily_summary" }>,
  appOrigin?: string | null,
): string {
  if (payload.projects.length === 0) return "**项目状态**：暂无关注项目";
  const lines = payload.projects.map((project, index) => {
    const risk = project.riskCount > 0 ? `｜风险 ${project.riskCount}` : "";
    return `${index + 1}. ${cardLink(project.name, project.linkPath, appOrigin)}｜${project.statusLabel}｜当前阶段：${project.currentStageName}（${project.currentStageStatusLabel}）｜项目 DDL：${project.projectDueAt ? `${formatNotificationDateTime(project.projectDueAt)}（${project.projectDueLabel}）` : "未设置"}｜负责人：${project.ownerNames || "未设置"}｜活跃任务 ${project.activeTaskCount} / 逾期 ${project.overdueTaskCount} / 待验收 ${project.pendingAcceptanceTaskCount}${risk}`;
  });
  appendMoreLine(lines, payload.projectTotalCount, payload.projects.length);
  return `**项目状态**：\n${lines.join("\n")}`;
}

function formatDailySummaryDdlSection(
  payload: Extract<ProgressNotifyPayload, { type: "progress_daily_summary" }>,
  appOrigin?: string | null,
): string {
  if (payload.ddlItems.length === 0) {
    return "**DDL 提醒**：未来 7 天暂无临期或逾期 DDL";
  }
  const lines = payload.ddlItems.map((item, index) => {
    const prefix =
      item.kind === "TASK" ? "任务" : item.kind === "STAGE" ? "阶段" : "项目";
    const stage = item.stageName ? `｜阶段：${item.stageName}` : "";
    return `${index + 1}. ${prefix}：${cardLink(item.title, item.linkPath, appOrigin)}｜${item.projectName}${stage}｜${formatNotificationDateTime(item.dueAt)}（${item.dueLabel}）`;
  });
  appendMoreLine(lines, payload.ddlTotalCount, payload.ddlItems.length);
  return `**DDL 提醒**：\n${lines.join("\n")}`;
}

function cardLink(label: string, path: string, appOrigin?: string | null): string {
  return `[${label.replace(/]/g, "\\]")} ](${buildAppUrl(path, appOrigin)})`.replace(
    " ](",
    "](",
  );
}

function appendMoreLine(lines: string[], total: number, visible: number) {
  if (total > visible) lines.push(`...还有 ${total - visible} 条，请打开系统查看`);
}

function formatTaskNotificationDetailLines(
  details: TaskNotificationDetails,
): string[] {
  const checklistSummary = formatAcceptanceChecklistSummary(
    details.acceptanceChecklistItems,
  );
  const lines = [
    details.stageName !== undefined
      ? `**阶段**：${details.stageName || "无阶段"}`
      : null,
    details.assigneeNames ? `**负责人**：${details.assigneeNames}` : null,
    details.taskTechGroups
      ? `**任务技术组**：${
          details.taskTechGroups.length > 0
            ? details.taskTechGroups.join("、")
            : "通用"
        }`
      : null,
    details.urgency || details.importance
      ? `**紧急/重要**：${
          details.urgency ? urgencyLabels[details.urgency] : "未设置"
        } / ${details.importance ? importanceLabels[details.importance] : "未设置"}`
      : null,
    details.dueAt ? `**DDL**：${formatNotificationDateTime(details.dueAt)}` : null,
    typeof details.needsWeeklyReport === "boolean"
      ? `**定期周报**：${
          details.needsWeeklyReport ? "需要（任务开始后生效）" : "不需要"
        }`
      : null,
    typeof details.needsOfflineConfirmation === "boolean"
      ? `**线下确认**：${details.needsOfflineConfirmation ? "需要" : "不需要"}`
      : null,
    details.metrics
      ? `**指标**：${compactCardText(details.metrics)}`
      : null,
    details.goal ? `**详细说明**：${compactCardText(details.goal)}` : null,
    checklistSummary,
  ];
  return lines.filter((line): line is string => !!line);
}

function compactCardText(value: string, maxLength = 260): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function formatAcceptanceChecklistSummary(items?: string[]): string | null {
  const normalized = items?.map((item) => item.trim()).filter(Boolean) ?? [];
  if (normalized.length === 0) return null;
  const visible = normalized
    .slice(0, 3)
    .map((item, index) => `${index + 1}. ${compactCardText(item, 80)}`);
  if (normalized.length > visible.length) {
    visible.push(`...还有 ${normalized.length - visible.length} 条`);
  }
  return `**验收清单**：\n${visible.join("\n")}`;
}

function formatBulkTaskLines(
  tasks: Array<{
    title: string;
    stageName: string;
    assigneeNames: string;
    taskTechGroups: string[];
    dueAt: string;
  }>,
): string {
  const visibleTasks = tasks.slice(0, 5);
  const lines = visibleTasks.map((task, index) => {
    const groups =
      task.taskTechGroups.length > 0 ? task.taskTechGroups.join("、") : "通用";
    return `${index + 1}. ${task.title}（${task.stageName} / ${groups} / ${
      task.assigneeNames || "未指定"
    } / ${formatDateTime(task.dueAt)}）`;
  });
  if (tasks.length > visibleTasks.length) {
    lines.push(`…还有 ${tasks.length - visibleTasks.length} 条`);
  }
  return lines.length > 0 ? `**任务概览**：\n${lines.join("\n")}` : "";
}

function formatBatchDueChangeAdjustment(durationDays: number): {
  directionLabel: "延期" | "提前";
  days: number;
} {
  return {
    directionLabel: durationDays < 0 ? "提前" : "延期",
    days: Math.abs(durationDays),
  };
}

function formatAffectedStageNames(stageNames: string[]): string {
  if (stageNames.length === 0) return "当前阶段及后续阶段";
  if (stageNames.length <= 4) return stageNames.join("、");
  return `${stageNames.slice(0, 4).join("、")} 等 ${stageNames.length} 个阶段`;
}

function formatNotificationDateTime(value: string | null): string {
  if (!value) return "未设置";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function runProgressOverdueCheck() {
  throw new Error(
    "runProgressOverdueCheck 已废弃；请使用 lib/progress-reminders.ts 的规则化 outbox 提醒入口",
  );
}

export async function runWeeklyReportReminders() {
  throw new Error(
    "runWeeklyReportReminders 已废弃；请使用 lib/progress-reminders.ts 的规则化 outbox 提醒入口",
  );
}

export async function runProgressDailyReminders() {
  throw new Error(
    "runProgressDailyReminders 已废弃；请使用 lib/progress-reminders.ts 的规则化 outbox 提醒入口",
  );
}
