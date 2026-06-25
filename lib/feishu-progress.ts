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
    }
  | {
      type: "project_started" | "project_completed" | "project_canceled";
      projectId: string;
      projectName: string;
      team: string;
      techGroup: string;
      ownerOpenIds: string[];
      ownerNames: string;
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
      type: "stage_pending_acceptance";
      projectId: string;
      projectName: string;
      stageName: string;
      team: string;
      techGroup: string;
      ownerOpenIds: string[];
      submitterOpenId: string;
      evidenceUrl: string;
    }
  | {
      type: "stage_approved" | "stage_rejected";
      projectId: string;
      projectName: string;
      stageName: string;
      stageOwnerOpenId: string;
    }
  | {
      type: "task_assigned";
      taskId: string;
      taskTitle: string;
      projectName: string;
      team: string;
      techGroup: string;
      assigneeOpenIds: string[];
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
      type: "task_pending_acceptance";
      taskId: string;
      taskTitle: string;
      projectName: string;
      team: string;
      techGroup: string;
      feishuDocUrl: string;
      keyDataUrl: string;
    }
  | {
      type: "task_approved";
      taskId: string;
      taskTitle: string;
      projectName: string;
      assigneeOpenIds: string[];
    }
  | {
      type: "task_rejected";
      taskId: string;
      taskTitle: string;
      projectName: string;
      assigneeOpenIds: string[];
      comment?: string;
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
      riskNote: string;
    }
  | {
      type: "weekly_report_reminder";
      taskId: string;
      taskTitle: string;
      assigneeOpenIds: string[];
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
      const card = buildCard(
        "新项目已创建",
        `**项目**：${payload.projectName}\n**负责人**：${payload.ownerNames}\n**车组/技术组**：${formatScope(payload.team, payload.techGroup)}`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
      );
      await notifyOpenIdsAndRoles(
        [...payload.ownerOpenIds, ...(payload.participantOpenIds ?? [])],
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
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
      const card = buildCard(
        title,
        `**项目**：${payload.projectName}\n**负责人**：${payload.ownerNames}\n**车组/技术组**：${formatScope(payload.team, payload.techGroup)}`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
        template,
      );
      await notifyOpenIdsAndRoles(
        payload.ownerOpenIds,
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
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
    case "stage_pending_acceptance": {
      const card = buildCard(
        "项目阶段待审批",
        `**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**归档链接**：[打开材料](${payload.evidenceUrl})`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
        "orange",
      );
      await notifyOpenIdsAndRoles(
        [...payload.ownerOpenIds, payload.submitterOpenId],
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "stage_approved":
    case "stage_rejected": {
      const pass = payload.type === "stage_approved";
      const card = buildCard(
        pass ? "项目阶段审批通过" : "项目阶段审批驳回",
        `**项目**：${payload.projectName}\n**阶段**：${payload.stageName}`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
        pass ? "green" : "red",
      );
      await sendDirectCard(payload.stageOwnerOpenId, card);
      break;
    }
    case "task_assigned": {
      const card = buildCard(
        "新任务指派",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
      );
      await notifyOpenIds(payload.assigneeOpenIds, card);
      break;
    }
    case "task_updated": {
      const card = buildCard(
        "任务信息已更新",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**修改人**：${payload.actorName}\n${formatChangeList(payload.changes)}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
      );
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
      break;
    }
    case "task_restarted": {
      const card = buildCard(
        "任务已重启",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**操作人**：${payload.actorName}\n**状态**：${taskStatusLabels[payload.fromStatus]} -> ${taskStatusLabels.IN_PROGRESS}\n**原因**：${payload.reason}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "orange",
      );
      await notifyOpenIdsAndRoles(
        [...payload.assigneeOpenIds, ...payload.projectOwnerOpenIds],
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "task_delete_requested": {
      const card = buildCard(
        "任务删除申请待审核",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**申请人**：${payload.requesterName}\n**原因**：${payload.reason}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "orange",
      );
      await notifyOpenIdsAndRoles(
        payload.projectOwnerOpenIds,
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
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
      await notifyOpenIdsAndRoles(
        [...payload.assigneeOpenIds, ...payload.projectOwnerOpenIds],
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
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
        [payload.requesterOpenId, ...payload.assigneeOpenIds],
        card,
      );
      break;
    }
    case "task_creation_requested": {
      const card = buildCard(
        "新任务申请待审核",
        `**项目**：${payload.projectName}\n**任务**：${payload.taskTitle}\n**申请人**：${payload.requesterName}`,
        buildAppUrl(`${routes.progress.project(payload.projectId)}`, appOrigin),
        "orange",
      );
      await notifyOpenIdsAndRoles(
        payload.projectOwnerOpenIds,
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "task_creation_approved": {
      const card = buildCard(
        "任务申请已通过",
        `**项目**：${payload.projectName}\n**任务**：${payload.taskTitle}\n**审核人**：${payload.reviewerName}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "green",
      );
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
    case "task_pending_acceptance": {
      const card = buildCard(
        "任务待验收",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**交付文档**：[打开文档](${payload.feishuDocUrl})\n**关键数据**：[打开材料](${payload.keyDataUrl})\n请先阅读材料后再在系统中审批。`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "orange",
      );
      await notifyRoles(
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "task_risk_synced": {
      const card = buildCard(
        "任务风险同步",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**风险**：${payload.riskNote}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "red",
      );
      await notifyOpenIdsAndRoles(
        [...payload.assigneeOpenIds, ...payload.projectOwnerOpenIds],
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER", "SUPER_ADMIN"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "task_approved": {
      const card = buildCard(
        "任务验收通过",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}`,
        buildAppUrl(`${routes.progress.task(payload.taskId)}`, appOrigin),
        "green",
      );
      await notifyOpenIds(payload.assigneeOpenIds, card);
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
      await notifyOpenIds(payload.assigneeOpenIds, card);
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

function formatChangeList(changes: string[]): string {
  if (changes.length === 0) return "**变更**：无字段变化";
  return `**变更**：\n${changes.map((change) => `- ${change}`).join("\n")}`;
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
