import { getFeishuTenantAccessToken } from "@/lib/feishu-auth";
import { getOpenIdsByRole } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import type { UserRoleType } from "@prisma/client";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export type ProgressNotifyPayload =
  | {
      type: "project_created";
      projectId: string;
      projectName: string;
      team: string;
      techGroup: string;
      ownerName: string;
    }
  | {
      type: "project_abnormal";
      projectId: string;
      projectName: string;
      team: string;
      techGroup: string;
      ownerName: string;
    }
  | {
      type: "task_assigned";
      taskId: string;
      taskTitle: string;
      projectName: string;
      team: string;
      techGroup: string;
      assigneeOpenId: string;
    }
  | {
      type: "task_pending_acceptance";
      taskId: string;
      taskTitle: string;
      projectName: string;
      team: string;
      techGroup: string;
      feishuDocUrl: string;
    }
  | {
      type: "task_approved";
      taskId: string;
      taskTitle: string;
      projectName: string;
      assigneeOpenId: string;
    }
  | {
      type: "task_overdue";
      taskId: string;
      taskTitle: string;
      projectName: string;
      team: string;
      techGroup: string;
      assigneeOpenId: string;
    }
  | {
      type: "weekly_report_reminder";
      taskId: string;
      taskTitle: string;
      assigneeOpenId: string;
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

export async function sendProgressNotification(payload: ProgressNotifyPayload) {
  switch (payload.type) {
    case "project_created": {
      const card = buildCard(
        "新项目已创建",
        `**项目**：${payload.projectName}\n**负责人**：${payload.ownerName}\n**车组/技术组**：${payload.team} / ${payload.techGroup}`,
        `${APP_URL}/progress/projects/${payload.projectId}`,
      );
      await notifyRoles(
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "project_abnormal": {
      const card = buildCard(
        "项目异常 — 请介入",
        `**项目**：${payload.projectName}\n**负责人**：${payload.ownerName}\n请及时组会确认并介入处理。`,
        `${APP_URL}/progress/projects/${payload.projectId}`,
        "red",
      );
      await notifyRoles(
        ["TEAM_ADMIN", "TECH_GROUP_ADMIN", "PROJECT_MANAGER"],
        { team: payload.team, techGroup: payload.techGroup },
        card,
      );
      break;
    }
    case "task_assigned": {
      const card = buildCard(
        "新任务指派",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}`,
        `${APP_URL}/progress/tasks/${payload.taskId}`,
      );
      await sendDirectCard(payload.assigneeOpenId, card);
      break;
    }
    case "task_pending_acceptance": {
      const card = buildCard(
        "任务待验收",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n**文档**：[打开飞书文档](${payload.feishuDocUrl})\n请先阅读文档后再在系统中审批。`,
        `${APP_URL}/progress/tasks/${payload.taskId}`,
        "orange",
      );
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
        `${APP_URL}/progress/tasks/${payload.taskId}`,
        "green",
      );
      await sendDirectCard(payload.assigneeOpenId, card);
      break;
    }
    case "task_overdue": {
      const card = buildCard(
        "任务逾期警报",
        `**任务**：${payload.taskTitle}\n**项目**：${payload.projectName}\n请负责人尽快推进，组长/项管请关注。`,
        `${APP_URL}/progress/tasks/${payload.taskId}`,
        "red",
      );
      await sendDirectCard(payload.assigneeOpenId, card);
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
        `${APP_URL}/progress/tasks/${payload.taskId}`,
        "orange",
      );
      await sendDirectCard(payload.assigneeOpenId, card);
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
    include: { project: true },
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
      assigneeOpenId: task.assigneeOpenId,
    }).catch(console.error);
  }

  return overdueTasks.length;
}

export async function runWeeklyReportReminders() {
  const activeTasks = await prisma.task.findMany({
    where: { status: { in: ["TODO", "IN_PROGRESS", "PENDING_ACCEPTANCE"] } },
  });

  for (const task of activeTasks) {
    await sendProgressNotification({
      type: "weekly_report_reminder",
      taskId: task.id,
      taskTitle: task.title,
      assigneeOpenId: task.assigneeOpenId,
    }).catch(console.error);
  }

  return activeTasks.length;
}

export async function runProgressDailyReminders() {
  const todayTasks = await prisma.task.findMany({
    where: {
      status: { in: ["TODO", "IN_PROGRESS"] },
      dueAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    },
    include: { project: true },
  });

  for (const task of todayTasks) {
    const card = buildCard(
      "今日任务提醒",
      `**任务**：${task.title}\n**项目**：${task.project.name}\n**截止**：${task.dueAt.toLocaleString("zh-CN")}`,
      `${APP_URL}/progress/tasks/${task.id}`,
    );
    await sendDirectCard(task.assigneeOpenId, card).catch(console.error);
  }

  return todayTasks.length;
}
