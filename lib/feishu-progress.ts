import { getFeishuTenantAccessToken } from "@/lib/feishu-auth";
import { getOpenIdsByRole } from "@/lib/permissions";
import { getTaskAssigneeOpenIds } from "@/lib/progress-assignees";
import { buildAppUrl, type NotificationContext } from "@/lib/app-origin";
import { prisma } from "@/lib/prisma";
import type { UserRoleType } from "@prisma/client";

export type ProgressNotifyPayload =
  | {
      type: "project_created";
      projectId: string;
      projectName: string;
      team: string;
      techGroup: string;
      ownerOpenId: string;
      ownerName: string;
    }
  | {
      type: "project_started" | "project_completed" | "project_canceled";
      projectId: string;
      projectName: string;
      team: string;
      techGroup: string;
      ownerOpenId: string;
      ownerName: string;
    }
  | {
      type: "stage_pending_acceptance";
      projectId: string;
      projectName: string;
      stageName: string;
      team: string;
      techGroup: string;
      ownerOpenId: string;
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
      projectOwnerOpenId: string;
      riskNote: string;
    }
  | {
      type: "weekly_report_reminder";
      taskId: string;
      taskTitle: string;
      assigneeOpenIds: string[];
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
  await Promise.allSettled(
    [...openIdSet].map((id) => sendDirectCard(id, card)),
  );
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
  await Promise.allSettled(
    [...openIdSet].map((id) => sendDirectCard(id, card)),
  );
}

async function notifyOpenIds(
  openIds: string[],
  card: ReturnType<typeof buildCard>,
) {
  const openIdSet = new Set(openIds.filter(Boolean));
  await Promise.allSettled(
    [...openIdSet].map((id) => sendDirectCard(id, card)),
  );
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
        `**项目**：${payload.projectName}\n**负责人**：${payload.ownerName}\n**车组/技术组**：${payload.team} / ${payload.techGroup}`,
        buildAppUrl(`/progress/projects/${payload.projectId}`, appOrigin),
      );
      await notifyOpenIdsAndRoles(
        [payload.ownerOpenId],
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER"],
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
        `**项目**：${payload.projectName}\n**负责人**：${payload.ownerName}\n**车组/技术组**：${payload.team} / ${payload.techGroup}`,
        buildAppUrl(`/progress/projects/${payload.projectId}`, appOrigin),
        template,
      );
      await notifyOpenIdsAndRoles(
        [payload.ownerOpenId],
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "stage_pending_acceptance": {
      const card = buildCard(
        "项目阶段待审批",
        `**项目**：${payload.projectName}\n**阶段**：${payload.stageName}\n**归档链接**：[打开材料](${payload.evidenceUrl})`,
        buildAppUrl(`/progress/projects/${payload.projectId}`, appOrigin),
        "orange",
      );
      await notifyOpenIdsAndRoles(
        [payload.ownerOpenId, payload.submitterOpenId],
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER"],
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
        buildAppUrl(`/progress/projects/${payload.projectId}`, appOrigin),
        pass ? "green" : "red",
      );
      await sendDirectCard(payload.stageOwnerOpenId, card);
      break;
    }
    case "task_assigned": {
      const card = buildCard(
        "新任务指派",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}`,
        buildAppUrl(`/progress/tasks/${payload.taskId}`, appOrigin),
      );
      await notifyOpenIds(payload.assigneeOpenIds, card);
      break;
    }
    case "task_pending_acceptance": {
      const card = buildCard(
        "任务待验收",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**交付文档**：[打开文档](${payload.feishuDocUrl})\n**关键数据**：[打开材料](${payload.keyDataUrl})\n请先阅读材料后再在系统中审批。`,
        buildAppUrl(`/progress/tasks/${payload.taskId}`, appOrigin),
        "orange",
      );
      await notifyRoles(
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "task_risk_synced": {
      const card = buildCard(
        "任务风险同步",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**风险**：${payload.riskNote}`,
        buildAppUrl(`/progress/tasks/${payload.taskId}`, appOrigin),
        "red",
      );
      await notifyOpenIds(payload.assigneeOpenIds, card).catch(console.error);
      await sendDirectCard(payload.projectOwnerOpenId, card).catch(console.error);
      await notifyRoles(
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "task_approved": {
      const card = buildCard(
        "任务验收通过",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}`,
        buildAppUrl(`/progress/tasks/${payload.taskId}`, appOrigin),
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
        buildAppUrl(`/progress/tasks/${payload.taskId}`, appOrigin),
        "red",
      );
      await notifyOpenIds(payload.assigneeOpenIds, card);
      break;
    }
    case "task_overdue": {
      const card = buildCard(
        "任务逾期警报",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n请负责人尽快推进，组长/项管请关注。`,
        buildAppUrl(`/progress/tasks/${payload.taskId}`, appOrigin),
        "red",
      );
      await notifyOpenIds(payload.assigneeOpenIds, card);
      await notifyRoles(
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "weekly_report_reminder": {
      const card = buildCard(
        "周报填写提醒",
        `**任务**：${payload.taskTitle}\n请在系统中提交本周进度周报。`,
        buildAppUrl(`/progress/tasks/${payload.taskId}`, appOrigin),
        "orange",
      );
      await notifyOpenIds(payload.assigneeOpenIds, card);
      break;
    }
  }
}

export async function runProgressOverdueCheck() {
  const now = new Date();
  const overdueTasks = await prisma.task.findMany({
    where: {
      dueAt: { lt: now },
      status: { in: ["TODO", "IN_PROGRESS", "PENDING_ACCEPTANCE"] },
      isOverdue: false,
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
    },
    include: { project: true, assignees: true },
  });

  for (const task of activeTasks) {
    const card = buildCard(
      "今日任务提醒",
      `**任务**：${task.title}\n**项目**：${task.project.name}\n**截止**：${task.dueAt.toLocaleString("zh-CN")}`,
      buildAppUrl(`/progress/tasks/${task.id}`),
    );
    await notifyOpenIds(
      getTaskAssigneeOpenIds(task),
      card,
    ).catch(console.error);
    await sendDirectCard(task.project.ownerOpenId, card).catch(console.error);
    await notifyRoles(
      ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER"],
      { team: task.team, techGroup: task.techGroup },
      card,
    );
  }

  return activeTasks.length;
}
