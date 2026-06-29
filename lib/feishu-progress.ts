import { getFeishuTenantAccessToken } from "@/lib/feishu-auth";
import { getOpenIdsByRole } from "@/lib/permissions";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { getProjectOwnerOpenIds } from "@/lib/progress-project-owners";
import { buildAppUrl, type NotificationContext } from "@/lib/app-origin";
import { prisma } from "@/lib/prisma";
import type { TaskStatus, UserRoleType } from "@prisma/client";
import { routes } from "@/lib/routes";
import { taskStatusLabels } from "@/lib/progress-labels";

export type ProgressNotifyPayload =
  | {
      type: "project_created";
      projectId: string;
      projectName: string;
      team: string;
      techGroup: string;
      ownerOpenIds: string[];
      ownerNames: string;
      participantOpenIds?: string[];
      participantNames?: string;
      recipientOpenIds?: string[];
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
      type: "task_assigned";
      taskId: string;
      taskTitle: string;
      projectName: string;
      team: string;
      techGroup: string;
      assigneeOpenIds: string[];
      recipientOpenIds?: string[];
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
    }
  | {
      type: "task_creation_rejected";
      requestId: string;
      projectId: string;
      projectName: string;
      taskTitle: string;
      reviewerName: string;
      requesterOpenId: string;
      comment: string;
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
      recipientOpenIds?: string[];
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
    };

function buildCard(
  title: string,
  content: string,
  url: string,
  template: "blue" | "red" | "orange" | "green" = "blue",
) {
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
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "打开系统" },
            url,
            type: "primary",
          },
        ],
      },
    ],
  };
}

async function sendDirectCard(
  openId: string,
  card: ReturnType<typeof buildCard>,
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
    throw new Error(`飞书私信失败(${openId}): ${data.msg}`);
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
}

export async function sendProgressNotification(
  payload: ProgressNotifyPayload,
  context?: NotificationContext,
) {
  const appOrigin = context?.appOrigin;

  switch (payload.type) {
    case "project_created": {
      const participantLine = `\n**参与人**：${payload.participantNames || "无"}`;
      const card = buildCard(
        "新项目已创建",
        `**项目**：${payload.projectName}\n**负责人**：${payload.ownerNames}${participantLine}\n**车组/技术组**：${formatScope(payload.team, payload.techGroup)}`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
      );
      if (payload.recipientOpenIds) {
        await notifyOpenIds(payload.recipientOpenIds, card);
      } else {
        await notifyOpenIdsAndRoles(
          [...payload.ownerOpenIds, ...(payload.participantOpenIds ?? [])],
          ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
          { team: payload.team, techGroup: payload.techGroup },
          card,
        );
      }
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
    case "project_updated": {
      const card = buildCard(
        "项目信息已更新",
        `**项目**：${payload.projectName}\n**修改人**：${payload.actorName}\n${formatChangeList(payload.changes)}`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
      );
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
      await notifyOpenIdsAndRoles(
        [...payload.ownerOpenIds, ...payload.stageOwnerOpenIds],
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
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
    case "task_assigned": {
      const card = buildCard(
        "新任务指派",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
      );
      await notifyOpenIds(payload.recipientOpenIds ?? payload.assigneeOpenIds, card);
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
        `**项目**：${payload.projectName}\n**任务**：${payload.taskTitle}\n**审核人**：${payload.reviewerName}`,
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
      await sendDirectCard(payload.requesterOpenId, card);
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
      const content = `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}${
        payload.comment ? `\n**驳回理由**：${payload.comment}` : ""
      }`;
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
      await notifyOpenIdsAndRoles(
        payload.assigneeOpenIds,
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "weekly_report_reminder": {
      const card = buildCard(
        "周报填写提醒",
        `**任务**：${payload.taskTitle}\n请在系统中提交本周进度周报。`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "orange",
      );
      await notifyOpenIds(payload.assigneeOpenIds, card);
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
  }
}

function formatScope(team: string, techGroup: string): string {
  return `${team || "未指定"} / ${techGroup || "未指定"}`;
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
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function runProgressOverdueCheck() {
  const now = new Date();
  const overdueTasks = await prisma.task.findMany({
    where: {
      dueAt: { lt: now },
      status: { in: ["TODO", "IN_PROGRESS", "PENDING_ACCEPTANCE"] },
      isOverdue: false,
      deletedAt: null,
    },
    include: { project: true, assignees: true },
  });

  for (const task of overdueTasks) {
    await prisma.task.update({
      where: { id: task.id },
      data: { isOverdue: true },
    });

    await sendProgressNotification({
      type: "task_overdue",
      taskId: task.id,
      taskTitle: task.title,
      projectName: task.project.name,
      team: task.team,
      techGroup: task.techGroup,
      assigneeOpenIds: getTaskAssigneeOpenIds(task),
    }).catch(console.error);
  }

  return overdueTasks.length;
}

export async function runWeeklyReportReminders() {
  const activeTasks = await prisma.task.findMany({
    where: {
      status: { in: ["TODO", "IN_PROGRESS", "PENDING_ACCEPTANCE"] },
      needsWeeklyReport: true,
      deletedAt: null,
    },
    include: { assignees: true },
  });

  for (const task of activeTasks) {
    await sendProgressNotification({
      type: "weekly_report_reminder",
      taskId: task.id,
      taskTitle: task.title,
      assigneeOpenIds: getTaskAssigneeOpenIds(task),
    }).catch(console.error);
  }

  return activeTasks.length;
}

export async function runProgressDailyReminders() {
  const activeTasks = await prisma.task.findMany({
    where: {
      status: { in: ["TODO", "IN_PROGRESS", "PENDING_ACCEPTANCE"] },
      deletedAt: null,
    },
    include: {
      project: {
        include: {
          owners: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      assignees: true,
    },
  });

  for (const task of activeTasks) {
    const card = buildCard(
      "今日任务提醒",
      `**任务**：${task.title}\n**项目**：${task.project.name}\n**截止**：${task.dueAt.toLocaleString("zh-CN")}`,
      buildAppUrl(`${routes.progress.task(task.id)}`),
    );
    await notifyOpenIdsAndRoles(
      [...getTaskAssigneeOpenIds(task), ...getProjectOwnerOpenIds(task.project)],
      ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER"],
      { team: task.team, techGroup: task.techGroup },
      card,
    );
  }

  return activeTasks.length;
}
